import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './database'
import type { Product, ProductUom, UnitRef } from './models'
import type { ProductUomInput } from './productUoms'
import { buildProductUomOrderOptions, getActiveProductUoms, getUomDescriptors, soldQuantityToInventoryQuantity } from '@/lib/productUoms'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'

const WORKSPACE_ID = 'c8200000-0000-4000-8000-000000000001'
const PRODUCT_ID = 'c8200000-0000-4000-8000-000000000002'

const remote = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  error: null as null | { message: string; code?: string },
}))

vi.mock('@/auth/supabase', () => ({
  isSupabaseConfigured: true,
  isBackendConfigurationRequired: false,
  supabase: (() => {
    const from = (table: string) => ({
      upsert: (payload: Record<string, unknown>) => {
        remote.calls.push({ table, payload })
        return {
          select: () => ({
            single: async () => ({ data: remote.error ? null : payload, error: remote.error }),
          }),
        }
      },
    })
    return { from, schema: () => ({ from }) }
  })(),
}))

vi.mock('./hooks', () => ({
  fetchTableFromSupabase: vi.fn(async () => undefined),
  addToOfflineMutations: vi.fn(async () => undefined),
}))

let replaceProductUoms: typeof import('./productUoms').replaceProductUoms
let validateProductUoms: typeof import('./productUoms').validateProductUoms

function baseProduct(overrides: Partial<Product> = {}): Product {
  const timestamp = '2026-09-29T09:00:00.000Z'
  return {
    id: PRODUCT_ID, workspaceId: WORKSPACE_ID, sku: 'UOM-1', name: 'UoM test product',
    description: '', categoryId: null, price: 1500, costPrice: 1000, minimumSellingPrice: 1200,
    quantity: 24, minStockLevel: 0, unit: 'pcs', currency: 'iqd', canBeReturned: true,
    createdAt: timestamp, updatedAt: timestamp, version: 1, isDeleted: false,
    syncStatus: 'synced', lastSyncedAt: timestamp, ...overrides,
  }
}

function uomRow(overrides: Partial<ProductUom> = {}): ProductUom {
  const timestamp = '2026-09-29T09:00:00.000Z'
  return {
    id: 'c8200000-0000-4000-8000-000000000003', workspaceId: WORKSPACE_ID,
    productId: PRODUCT_ID, unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1,
    isBase: true, isActive: true, isDefaultSelling: true, sellingPrice: 1500,
    costPrice: 1000, minimumSellingPrice: 1200, createdAt: timestamp, updatedAt: timestamp,
    version: 1, isDeleted: false, syncStatus: 'synced', lastSyncedAt: timestamp,
    ...overrides,
  }
}

describe('Product UoM conversion and persistence', () => {
  beforeAll(async () => {
    installTestBrowser()
    const service = await import('./productUoms')
    replaceProductUoms = service.replaceProductUoms
    validateProductUoms = service.validateProductUoms
  })

  beforeEach(async () => {
    await db.delete()
    await db.open()
    remote.calls = []
    remote.error = null
    setNetworkStatus(true)
    setActiveBusinessWorkspace(WORKSPACE_ID)
    setActiveBusinessUser('c8200000-0000-4000-8000-000000000004', 'admin', WORKSPACE_ID)
  })

  afterAll(async () => {
    await db.delete()
    setActiveBusinessUser(null)
    setActiveBusinessWorkspace(null)
    setNetworkStatus(true)
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
  })

  it('converts fractional and whole selected quantities into canonical base stock', () => {
    expect(soldQuantityToInventoryQuantity(2, 6)).toBe(12)
    expect(soldQuantityToInventoryQuantity(0.5, 0.25)).toBe(0.125)
    expect(soldQuantityToInventoryQuantity(1.1234567, 0.125)).toBe(0.140432)
  })

  it('keeps independent prices and costs while exposing coefficient-based order choices', () => {
    const product = baseProduct()
    const pack = uomRow({
      id: 'c8200000-0000-4000-8000-000000000005', unitRef: 'builtin:pack', unitCode: 'pack',
      coefficient: 6, isBase: false, isDefaultSelling: false, sellingPrice: 8500,
      costPrice: 5700, minimumSellingPrice: 6800,
    })
    const box = uomRow({
      id: 'c8200000-0000-4000-8000-000000000006', unitRef: 'builtin:box', unitCode: 'box',
      coefficient: 24, isBase: false, isDefaultSelling: true, sellingPrice: 32000,
      costPrice: 21600, minimumSellingPrice: 25500,
    })
    const rows = [uomRow({ isDefaultSelling: false }), pack, box]
    const descriptors = getUomDescriptors([])
    const active = getActiveProductUoms(product, rows, descriptors)
    expect(active.map(({ unitCode, coefficient, sellingPrice, costPrice, minimumSellingPrice }) => ({
      unitCode, coefficient, sellingPrice, costPrice, minimumSellingPrice,
    }))).toEqual([
      { unitCode: 'pcs', coefficient: 1, sellingPrice: 1500, costPrice: 1000, minimumSellingPrice: 1200 },
      { unitCode: 'pack', coefficient: 6, sellingPrice: 8500, costPrice: 5700, minimumSellingPrice: 6800 },
      { unitCode: 'box', coefficient: 24, sellingPrice: 32000, costPrice: 21600, minimumSellingPrice: 25500 },
    ])
    expect(buildProductUomOrderOptions(product, rows, descriptors).find((row) => row.isDefaultSelling))
      .toMatchObject({ uomId: box.id, factor: 24, sellingPrice: 32000, costPrice: 21600, minimumSellingPrice: 25500 })
  })

  it('requires one coefficient-one base, one active default, unique unit IDs, and supported decimal precision', () => {
    const base: ProductUomInput = {
      unitRef: 'builtin:pcs' as UnitRef, unitCode: 'pcs', coefficient: 1, isBase: true,
      isActive: true, isDefaultSelling: true, sellingPrice: 1500, costPrice: 1000, minimumSellingPrice: 1200,
    }
    expect(() => validateProductUoms([base, {
      ...base, unitRef: 'builtin:portion', unitCode: 'portion', coefficient: 0.125,
      isBase: false, isDefaultSelling: false,
    }])).not.toThrow()
    expect(() => validateProductUoms([{ ...base, coefficient: 6 }])).toThrow('product_uom_base_coefficient')
    expect(() => validateProductUoms([base, { ...base, unitRef: 'builtin:alias', unitCode: 'alias', isBase: false,
      isDefaultSelling: false }])).toThrow('product_uom_non_base_coefficient_one')
    expect(() => validateProductUoms([{ ...base, isDefaultSelling: false }])).toThrow('product_uom_default_required')
    expect(() => validateProductUoms([base, {
      ...base, unitRef: 'builtin:pack', isBase: false, unitCode: 'pack', coefficient: 6,
    }]))
      .toThrow('product_uom_multiple_defaults')
    expect(() => validateProductUoms([base, {
      ...base, unitRef: 'builtin:portion', unitCode: 'portion', coefficient: 0.1234567,
      isBase: false, isDefaultSelling: false,
    }])).toThrow('product_uom_invalid')
  })

  for (const mode of ['cloud', 'hybrid'] as const) {
    it(`${mode}: sends scoped UoMs to Supabase before updating the local cache`, async () => {
      writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: mode })
      await db.products.put(baseProduct())
      const rows = await replaceProductUoms(WORKSPACE_ID, PRODUCT_ID, [
        { unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1, isBase: true, isActive: true,
          isDefaultSelling: false, sellingPrice: 1500, costPrice: 1000, minimumSellingPrice: 1200 },
        { unitRef: 'builtin:pack', unitCode: 'pack', coefficient: 6, isBase: false, isActive: true,
          isDefaultSelling: true, sellingPrice: 8500, costPrice: 5700, minimumSellingPrice: 6800 },
      ])
      expect(remote.calls).toHaveLength(2)
      expect(remote.calls[0]).toMatchObject({
        table: 'product_uoms',
        payload: expect.objectContaining({ workspace_id: WORKSPACE_ID, product_id: PRODUCT_ID, unit_ref: 'builtin:pcs', coefficient: 1 }),
      })
      expect(remote.calls[1]).toMatchObject({
        table: 'product_uoms',
        payload: expect.objectContaining({ unit_ref: 'builtin:pack', coefficient: 6, selling_price: 8500, cost_price: 5700, minimum_selling_price: 6800 }),
      })
      expect(rows).toHaveLength(2)
      expect(await db.product_uoms.where('productId').equals(PRODUCT_ID).count()).toBe(2)
      expect(await db.product_uoms.where('productId').equals(PRODUCT_ID).and((row) => row.isDefaultSelling === true).first())
        .toMatchObject({ unitCode: 'pack', coefficient: 6, syncStatus: 'synced' })
    })
  }

  it('demotes an old Cloud base UoM before inserting its replacement', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
    await db.products.put(baseProduct({ unit: 'kg' }))
    await db.product_uoms.put(uomRow())

    const rows = await replaceProductUoms(WORKSPACE_ID, PRODUCT_ID, [{
      unitRef: 'builtin:kg', unitCode: 'kg', coefficient: 1, isBase: true,
      isActive: true, isDefaultSelling: true, sellingPrice: 1500, costPrice: 1000, minimumSellingPrice: 1200,
    }])

    expect(remote.calls.map((call) => call.payload)).toMatchObject([
      { unit_ref: 'builtin:pcs', is_base: false, is_active: false, is_default_selling: false },
      { unit_ref: 'builtin:kg', is_base: true, is_active: true, is_default_selling: true },
    ])
    expect(rows).toHaveLength(1)
    expect(await db.product_uoms.get(uomRow().id)).toMatchObject({ isBase: false, isActive: false })
    expect(await db.product_uoms.where('productId').equals(PRODUCT_ID).and((row) => row.isBase && row.isActive).count()).toBe(1)
  })

  it('blocks changing the base unit while stock exists', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    await db.products.put(baseProduct({ unit: 'kg' }))
    await db.product_uoms.put(uomRow())
    await db.inventory.put({
      id: 'inventory-row', workspaceId: WORKSPACE_ID, productId: PRODUCT_ID,
      storageId: 'storage', quantity: 6, isDeleted: false,
    } as never)

    await expect(replaceProductUoms(WORKSPACE_ID, PRODUCT_ID, [{
      unitRef: 'builtin:kg', unitCode: 'kg', coefficient: 1, isBase: true,
      isActive: true, isDefaultSelling: true, sellingPrice: 1500, costPrice: 1000, minimumSellingPrice: 1200,
    }])).rejects.toThrow('product_uom_base_change_has_history')
    expect(await db.product_uoms.get(uomRow().id)).toMatchObject({ unitRef: 'builtin:pcs', isBase: true })
  })

  it('keeps the local catalog unchanged and reports a friendly error when Supabase rejects a UoM', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
    await db.products.put(baseProduct())
    remote.error = { message: 'permission denied', code: '42501' }

    await expect(replaceProductUoms(WORKSPACE_ID, PRODUCT_ID, [
      { unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1, isBase: true, isActive: true,
        isDefaultSelling: true, sellingPrice: 1500, costPrice: 1000, minimumSellingPrice: 1200 },
    ])).rejects.toThrow()
    expect(remote.calls).toHaveLength(1)
    expect(await db.product_uoms.count()).toBe(0)
    expect(await db.offline_mutations.count()).toBe(0)
  })
})
