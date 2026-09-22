import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setActiveBusinessUser, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000901'
const PRODUCT_ID = '00000000-0000-4000-8000-000000000902'
const RELATIONSHIP_ID = '00000000-0000-4000-8000-000000000903'
const STORAGE_A = '00000000-0000-4000-8000-000000000904'
const STORAGE_B = '00000000-0000-4000-8000-000000000905'
const PRICE_BOOK_ID = '00000000-0000-4000-8000-000000000906'
const USER_ID = '00000000-0000-4000-8000-000000000907'

const remote = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  data: null as unknown,
  error: null as null | { message: string; code?: string },
}))

vi.mock('@/auth/supabase', () => ({
  isSupabaseConfigured: true,
  isBackendConfigurationRequired: false,
  supabase: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      remote.calls.push({ name, args })
      return { data: remote.data, error: remote.error }
    },
  },
}))

let conversionModule: typeof import('./productRelationalConversion')

function baseInput() {
  return {
    workspaceId: WORKSPACE_ID,
    productId: PRODUCT_ID,
    relationshipId: RELATIONSHIP_ID,
    factor: 20,
    parentPrice: 40_000,
    childIsDynamic: false,
    initialStock: 20,
    storageId: STORAGE_B,
    createdBy: USER_ID,
    product: {
      sku: 'PANA-500',
      name: 'Panadol 500mg',
      description: 'Converted product',
      categoryId: null,
      category: null,
      price: 2_250,
      costPrice: 1_200,
      minStockLevel: 3,
      currency: 'iqd' as const,
      imageUrl: '',
      canBeReturned: true,
      returnRules: '',
    },
    priceBookItems: [{
      priceBookId: PRICE_BOOK_ID,
      costPrice: 1_100,
      price: 2_100,
      parentPrice: 38_000,
      currency: 'iqd' as const,
    }],
  }
}

async function seedBaseData(mode: 'local' | 'cloud' | 'hybrid') {
  writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: mode })
  const now = '2026-09-22T09:00:00.000Z'
  await db.workspaces.put({
    id: WORKSPACE_ID,
    name: 'Relational conversion test',
    data_mode: mode,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
    lastSyncedAt: now,
    version: 1,
    isDeleted: false,
  } as never)
  await db.storages.bulkPut([
    {
      id: STORAGE_A, workspaceId: WORKSPACE_ID, name: 'Storage A', isSystem: false,
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false,
    },
    {
      id: STORAGE_B, workspaceId: WORKSPACE_ID, name: 'Storage B', isSystem: false,
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false,
    },
  ] as never)
  await db.unit_relationships.put({
    id: RELATIONSHIP_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Carton and Sheet',
    parentUnitRef: 'builtin:carton',
    parentUnitCode: 'carton',
    childUnitRef: 'builtin:sheet',
    childUnitCode: 'sheet',
    isArchived: false,
    createdBy: USER_ID,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
    lastSyncedAt: now,
    version: 1,
    isDeleted: false,
  })
  await db.products.put({
    id: PRODUCT_ID,
    workspaceId: WORKSPACE_ID,
    sku: 'PANA-OLD',
    skuKey: 'pana-old',
    name: 'Old Panadol',
    description: '',
    categoryId: null,
    category: null,
    price: 35_000,
    costPrice: 25_000,
    quantity: 15,
    minStockLevel: 3,
    unit: 'pcs',
    currency: 'iqd',
    imageUrl: '',
    canBeReturned: true,
    returnRules: '',
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
    lastSyncedAt: now,
    version: 1,
    isDeleted: false,
  })
  await db.inventory.bulkPut([
    {
      id: '00000000-0000-4000-8000-000000000911', workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID, storageId: STORAGE_A, quantity: 10,
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false,
    },
    {
      id: '00000000-0000-4000-8000-000000000912', workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID, storageId: STORAGE_B, quantity: 5,
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false,
    },
  ])
  await db.stock_batches.bulkPut([
    {
      id: '00000000-0000-4000-8000-000000000913', workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID, storageId: STORAGE_A, batchNumber: 'OLD-A', quantity: 10,
      price: 35_000, costPrice: 25_000, currency: 'iqd',
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false,
    },
    {
      id: '00000000-0000-4000-8000-000000000914', workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID, storageId: STORAGE_B, batchNumber: 'OLD-B', quantity: 5,
      price: 35_000, costPrice: 25_000, currency: 'iqd',
      createdAt: now, updatedAt: now, syncStatus: 'synced', lastSyncedAt: now, version: 1, isDeleted: false,
    },
  ])
  await db.price_books.put({
    id: PRICE_BOOK_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Wholesale',
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
    lastSyncedAt: now,
    version: 1,
    isDeleted: false,
  })
  await db.price_book_items.put({
    id: '00000000-0000-4000-8000-000000000915',
    workspaceId: WORKSPACE_ID,
    productId: PRODUCT_ID,
    priceBookId: PRICE_BOOK_ID,
    costPrice: 24_000,
    price: 34_000,
    currency: 'iqd',
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
    lastSyncedAt: now,
    version: 1,
    isDeleted: false,
  })
}

describe('single-unit to relational-unit persistence', () => {
  beforeAll(async () => {
    installTestBrowser()
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true, userAgent: 'node-test' },
    })
    conversionModule = await import('./productRelationalConversion')
  }, 90_000)

  beforeEach(async () => {
    setNetworkStatus(true)
    setActiveBusinessUser(USER_ID, 'admin', WORKSPACE_ID)
    remote.calls.length = 0
    remote.data = null
    remote.error = null
    await db.delete()
    await db.open()
  })

  afterEach(() => {
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
    setNetworkStatus(true)
    setActiveBusinessUser(null)
  })

  afterAll(async () => {
    await db.delete()
  })

  it('replaces Local stock, retires old batches, and saves independent main and Price Book prices atomically', async () => {
    await seedBaseData('local')

    const result = await conversionModule.convertSingleUnitProductToRelationship(baseInput())

    expect(result.product).toMatchObject({
      unit: 'sheet', quantity: 20, storageId: STORAGE_B, price: 2_250, costPrice: 1_200, minStockLevel: 3,
    })
    expect(await db.inventory.where('productId').equals(PRODUCT_ID).toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ storageId: STORAGE_A, quantity: 0, isDeleted: true }),
      expect.objectContaining({ storageId: STORAGE_B, quantity: 20, isDeleted: false }),
    ]))
    expect((await db.stock_batches.where('productId').equals(PRODUCT_ID).toArray()).map((row) => row.quantity)).toEqual([0, 0])
    expect(await db.product_unit_conversions.where('productId').equals(PRODUCT_ID).first()).toMatchObject({
      relationshipId: RELATIONSHIP_ID, factor: 20, parentPrice: 40_000,
    })
    expect(await db.price_book_items.where('productId').equals(PRODUCT_ID).first()).toMatchObject({
      costPrice: 1_100, price: 2_100,
    })
    expect(await db.price_book_unit_prices.where('productId').equals(PRODUCT_ID).first()).toMatchObject({
      unitRef: 'builtin:carton', price: 38_000,
    })
    expect(remote.calls).toHaveLength(0)
  })

  it('rolls the Local transaction back when a selected Price Book is unavailable', async () => {
    await seedBaseData('local')
    const originalProduct = await db.products.get(PRODUCT_ID)
    const originalInventory = await db.inventory.where('productId').equals(PRODUCT_ID).toArray()
    const originalBatches = await db.stock_batches.where('productId').equals(PRODUCT_ID).toArray()

    await expect(conversionModule.convertSingleUnitProductToRelationship({
      ...baseInput(),
      priceBookItems: [{ ...baseInput().priceBookItems[0], priceBookId: '00000000-0000-4000-8000-000000000999' }],
    })).rejects.toMatchObject({ code: 'validation' })

    expect(await db.products.get(PRODUCT_ID)).toEqual(originalProduct)
    expect(await db.inventory.where('productId').equals(PRODUCT_ID).toArray()).toEqual(originalInventory)
    expect(await db.stock_batches.where('productId').equals(PRODUCT_ID).toArray()).toEqual(originalBatches)
    expect(await db.product_unit_conversions.where('productId').equals(PRODUCT_ID).count()).toBe(0)
  })

  it.each(['cloud', 'hybrid'] as const)('uses one authoritative RPC and caches its returned %s records', async (mode) => {
    await seedBaseData(mode)
    const now = '2026-09-22T10:00:00.000Z'
    remote.data = {
      product: {
        id: PRODUCT_ID, workspace_id: WORKSPACE_ID, sku: 'PANA-500', name: 'Panadol 500mg', description: 'Converted product',
        category_id: null, category: null, price: 2250, cost_price: 1200, quantity: 20, min_stock_level: 3,
        unit: 'sheet', currency: 'iqd', image_url: '', can_be_returned: true, return_rules: '', storage_id: STORAGE_B,
        created_at: now, updated_at: now, version: 3, is_deleted: false,
      },
      conversion: {
        id: '00000000-0000-4000-8000-000000000920', workspace_id: WORKSPACE_ID, product_id: PRODUCT_ID,
        relationship_id: RELATIONSHIP_ID, factor: 20, parent_price: 40000, created_by: USER_ID,
        created_at: now, updated_at: now, version: 1, is_deleted: false,
      },
      inventory: [{
        id: '00000000-0000-4000-8000-000000000912', workspace_id: WORKSPACE_ID, product_id: PRODUCT_ID,
        storage_id: STORAGE_B, quantity: 20, created_at: now, updated_at: now, version: 2, is_deleted: false,
      }],
      stock_batches: [],
      price_book_items: [{
        id: '00000000-0000-4000-8000-000000000915', workspace_id: WORKSPACE_ID, product_id: PRODUCT_ID,
        price_book_id: PRICE_BOOK_ID, cost_price: 1100, price: 2100, currency: 'iqd',
        created_at: now, updated_at: now, version: 2, is_deleted: false,
      }],
      price_book_unit_prices: [{
        id: '00000000-0000-4000-8000-000000000921', workspace_id: WORKSPACE_ID, product_id: PRODUCT_ID,
        price_book_id: PRICE_BOOK_ID, unit_ref: 'builtin:carton', price: 38000, currency: 'iqd',
        created_at: now, updated_at: now, version: 1, is_deleted: false,
      }],
    }

    await conversionModule.convertSingleUnitProductToRelationship(baseInput())

    expect(remote.calls).toHaveLength(1)
    expect(remote.calls[0]).toMatchObject({
      name: 'convert_single_unit_product_to_relationship',
      args: {
        p_payload: {
          product_id: PRODUCT_ID,
          relationship_id: RELATIONSHIP_ID,
          initial_stock: 20,
          storage_id: STORAGE_B,
          product: { price: 2_250, cost_price: 1_200 },
          price_book_items: [{ price: 2_100, parent_price: 38_000 }],
        },
      },
    })
    expect(await db.products.get(PRODUCT_ID)).toMatchObject({ unit: 'sheet', quantity: 20, storageName: 'Storage B' })
    expect(await db.product_unit_conversions.where('productId').equals(PRODUCT_ID).count()).toBe(1)
  })

  it('keeps Cloud cache unchanged and returns a friendly code when the RPC rejects storage access', async () => {
    await seedBaseData('cloud')
    const originalProduct = await db.products.get(PRODUCT_ID)
    remote.error = { message: 'single_unit_conversion_storage_access', code: '42501' }

    await expect(conversionModule.convertSingleUnitProductToRelationship(baseInput()))
      .rejects.toMatchObject({ code: 'storage_access' })

    expect(remote.calls).toHaveLength(1)
    expect(await db.products.get(PRODUCT_ID)).toEqual(originalProduct)
    expect(await db.product_unit_conversions.where('productId').equals(PRODUCT_ID).count()).toBe(0)
  })

  it('requires Cloud conversion to be online before issuing any write', async () => {
    await seedBaseData('cloud')
    setNetworkStatus(false)

    await expect(conversionModule.convertSingleUnitProductToRelationship(baseInput()))
      .rejects.toMatchObject({ code: 'online_required' })
    expect(remote.calls).toHaveLength(0)
  })
})

