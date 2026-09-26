import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000801'
const PRODUCT_ID = '00000000-0000-4000-8000-000000000802'
const PRICE_BOOK_ID = '00000000-0000-4000-8000-000000000803'

const remote = vi.hoisted(() => ({
  calls: [] as Array<{
    table: string
    payload: Record<string, unknown> | Array<Record<string, unknown>>
    options?: Record<string, unknown>
  }>,
  error: null as null | { message: string; code?: string },
}))

vi.mock('@/auth/supabase', () => ({
  isSupabaseConfigured: true,
  isBackendConfigurationRequired: false,
  supabase: (() => {
    const client: any = {
      from: (table: string) => ({
      upsert: (
        payload: Record<string, unknown> | Array<Record<string, unknown>>,
        options?: Record<string, unknown>,
      ) => {
        remote.calls.push({ table, payload, options })
        const data = Array.isArray(payload) ? payload : { ...payload }
        const response = () => Promise.resolve({ data, error: remote.error })
        return {
          select: () => {
            const promise = response() as Promise<{ data: unknown; error: typeof remote.error }> & {
              single?: () => Promise<{ data: unknown; error: typeof remote.error }>
            }
            promise.single = async () => ({
              data: Array.isArray(data) ? data[0] : data,
              error: remote.error,
            })
            return promise
          },
        }
      },
      }),
      schema: () => undefined,
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'test-user' } } } }),
      },
    }
    client.schema = () => client
    return client
  })(),
}))

let unitRelationships: typeof import('./unitRelationships')

async function putProduct(unit = 'sheet', id = PRODUCT_ID, isDeleted = false) {
  const now = new Date().toISOString()
  await db.products.put({
    id,
    workspaceId: WORKSPACE_ID,
    sku: `PACK-${id}`,
    skuKey: `pack-${id}`,
    name: 'Cloud packaged product',
    unit,
    price: 2_250,
    costPrice: 1_000,
    currency: 'iqd',
    quantity: 100,
    minStockLevel: 0,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
    lastSyncedAt: now,
    version: 1,
    isDeleted,
  } as never)
}

describe('hierarchical unit persistence', () => {
  beforeAll(async () => {
    installTestBrowser()
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true, userAgent: 'node-test' },
    })
    unitRelationships = await import('./unitRelationships')
  }, 90_000)

  beforeEach(async () => {
    setNetworkStatus(true)
    remote.calls.length = 0
    remote.error = null
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
    const now = new Date().toISOString()
    await db.workspaces.put({
      id: WORKSPACE_ID,
      name: 'Cloud packaging test',
      data_mode: 'cloud',
      createdAt: now,
      updatedAt: now,
      syncStatus: 'synced',
      lastSyncedAt: now,
      version: 1,
      isDeleted: false,
    } as never)
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
    } as never)
  })

  afterEach(() => {
    setNetworkStatus(true)
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
  })
  afterAll(async () => { await db.delete() })

  it('writes relationship, product conversion, and parent Price Book price using snake-case contracts', async () => {
    const relationship = await unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      name: 'Pharmaceutical packaging',
      parentUnitRef: 'builtin:carton',
      parentUnitCode: 'carton',
      childUnitRef: 'builtin:sheet',
      childUnitCode: 'sheet',
    })
    await putProduct()
    await unitRelationships.replaceProductUnitConversion(WORKSPACE_ID, PRODUCT_ID, {
      relationshipId: relationship.id,
      factor: 20,
      parentPrice: 40_000,
      childIsDynamic: false,
    })
    await unitRelationships.replaceProductPriceBookUnitPrices(WORKSPACE_ID, PRODUCT_ID, [{
      priceBookId: PRICE_BOOK_ID,
      unitRef: 'builtin:carton',
      price: 38_000,
      currency: 'iqd',
    }])

    expect(remote.calls.map((call) => call.table)).toEqual([
      'unit_relationships',
      'product_unit_conversions',
      'price_book_unit_prices',
    ])
    expect(remote.calls[0]).toMatchObject({
      options: { onConflict: 'id' },
      payload: {
        workspace_id: WORKSPACE_ID,
        parent_unit_ref: 'builtin:carton',
        child_unit_ref: 'builtin:sheet',
      },
    })
    expect(remote.calls[1]).toMatchObject({
      options: { onConflict: 'product_id' },
      payload: { product_id: PRODUCT_ID, relationship_id: relationship.id, factor: 20, parent_price: 40_000 },
    })
    expect(remote.calls[2]).toMatchObject({
      options: { onConflict: 'price_book_id,product_id,unit_ref' },
    })
    expect(await db.product_unit_conversions.where('productId').equals(PRODUCT_ID).first()).toMatchObject({
      relationshipId: relationship.id,
      factor: 20,
      parentPrice: 40_000,
      syncStatus: 'synced',
    })
    expect(await db.price_book_unit_prices.where('productId').equals(PRODUCT_ID).first()).toMatchObject({
      priceBookId: PRICE_BOOK_ID,
      unitRef: 'builtin:carton',
      price: 38_000,
      currency: 'iqd',
    })
  })

  it('surfaces a failed remote relationship write without leaving an optimistic local row', async () => {
    remote.error = { message: 'relationship write rejected', code: '23514' }

    await expect(unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:carton',
      parentUnitCode: 'carton',
      childUnitRef: 'builtin:sheet',
      childUnitCode: 'sheet',
    })).rejects.toThrow()

    expect(remote.calls).toHaveLength(1)
    expect(await db.unit_relationships.count()).toBe(0)
  })

  it('blocks relationship creation when an active product already uses either endpoint', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    await putProduct('sheet')

    await expect(unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:carton',
      parentUnitCode: 'carton',
      childUnitRef: 'builtin:sheet',
      childUnitCode: 'sheet',
    })).rejects.toBeInstanceOf(unitRelationships.UnitRelationshipEndpointInUseError)

    expect(await db.unit_relationships.count()).toBe(0)
  })

  it('maps authoritative endpoint conflicts to a friendly relationship error', async () => {
    remote.error = {
      message: 'Unit relationship endpoint is already used by a product',
      code: '23514',
    }

    await expect(unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:carton',
      parentUnitCode: 'carton',
      childUnitRef: 'builtin:sheet',
      childUnitCode: 'sheet',
    })).rejects.toBeInstanceOf(unitRelationships.UnitRelationshipEndpointInUseError)

    expect(remote.calls).toHaveLength(1)
    expect(await db.unit_relationships.count()).toBe(0)
  })

  it('blocks structural Cloud relationship changes offline until product usage can be verified', async () => {
    setNetworkStatus(false)

    await expect(unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:carton',
      parentUnitCode: 'carton',
      childUnitRef: 'builtin:sheet',
      childUnitCode: 'sheet',
    })).rejects.toBeInstanceOf(unitRelationships.UnitRelationshipVerificationRequiredError)

    expect(remote.calls).toHaveLength(0)
    expect(await db.unit_relationships.count()).toBe(0)
  })

  it('prevents archiving a relationship directly used by an active product', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    const relationship = await unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:carton',
      parentUnitCode: 'carton',
      childUnitRef: 'builtin:sheet',
      childUnitCode: 'sheet',
    })
    await putProduct()
    await unitRelationships.replaceProductUnitConversion(WORKSPACE_ID, PRODUCT_ID, {
      relationshipId: relationship.id,
      factor: 20,
      parentPrice: 40_000,
      childIsDynamic: false,
    })

    await expect(unitRelationships.setUnitRelationshipArchived(relationship.id, true))
      .rejects.toBeInstanceOf(unitRelationships.UnitRelationshipInUseError)
    expect(await db.unit_relationships.get(relationship.id)).toMatchObject({ isArchived: false })
  })

  it('reserves both endpoints of a product relationship against later relationships and restores', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    const usedRelationship = await unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:carton',
      parentUnitCode: 'carton',
      childUnitRef: 'builtin:sheet',
      childUnitCode: 'sheet',
    })
    const archivedRelationship = await unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:case',
      parentUnitCode: 'case',
      childUnitRef: 'builtin:carton',
      childUnitCode: 'carton',
    })
    await unitRelationships.setUnitRelationshipArchived(archivedRelationship.id, true)
    await putProduct()
    await unitRelationships.replaceProductUnitConversion(WORKSPACE_ID, PRODUCT_ID, {
      relationshipId: usedRelationship.id,
      factor: 20,
      parentPrice: 40_000,
      childIsDynamic: false,
    })

    await expect(unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:bale',
      parentUnitCode: 'bale',
      childUnitRef: 'builtin:carton',
      childUnitCode: 'carton',
    })).rejects.toBeInstanceOf(unitRelationships.UnitRelationshipEndpointInUseError)
    await expect(unitRelationships.setUnitRelationshipArchived(archivedRelationship.id, false))
      .rejects.toBeInstanceOf(unitRelationships.UnitRelationshipEndpointInUseError)
  })

  it('does not reserve units used only by deleted products', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    await putProduct('sheet', PRODUCT_ID, true)

    await expect(unitRelationships.saveUnitRelationship(WORKSPACE_ID, {
      parentUnitRef: 'builtin:carton',
      parentUnitCode: 'carton',
      childUnitRef: 'builtin:sheet',
      childUnitCode: 'sheet',
    })).resolves.toMatchObject({ parentUnitCode: 'carton', childUnitCode: 'sheet' })
  })

  it('converts Local-mode product, storage, and batch quantities atomically with quantity rounding', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    const now = new Date().toISOString()
    await putProduct('carton')
    await db.products.update(PRODUCT_ID, { quantity: 0.1, minStockLevel: 0.2, costPrice: 10 })
    await db.inventory.put({
      id: '00000000-0000-4000-8000-000000000804',
      workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID,
      storageId: '00000000-0000-4000-8000-000000000805',
      quantity: 0.1,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'synced',
      lastSyncedAt: now,
      version: 1,
      isDeleted: false,
    } as never)
    await db.stock_batches.put({
      id: '00000000-0000-4000-8000-000000000806',
      workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID,
      storageId: '00000000-0000-4000-8000-000000000805',
      batchNumber: 'PACK-ROUNDING',
      quantity: 0.1,
      price: 30,
      costPrice: 9,
      currency: 'usd',
      createdAt: now,
      updatedAt: now,
      syncStatus: 'synced',
      lastSyncedAt: now,
      version: 1,
      isDeleted: false,
    } as never)

    await unitRelationships.convertProductInventoryToChildUnit({
      workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID,
      factor: 3,
      childUnitCode: 'sheet',
    })

    expect(await db.products.get(PRODUCT_ID)).toMatchObject({
      unit: 'sheet', quantity: 0.3, minStockLevel: 0.6,
    })
    expect(await db.inventory.get('00000000-0000-4000-8000-000000000804')).toMatchObject({ quantity: 0.3 })
    expect(await db.stock_batches.get('00000000-0000-4000-8000-000000000806')).toMatchObject({
      quantity: 0.3, price: 10, costPrice: 3,
    })
    expect(await db.inventory_transactions.toArray()).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        productId: PRODUCT_ID,
        storageId: '00000000-0000-4000-8000-000000000805',
        transactionType: 'inventory_change',
        quantityDelta: 0.2,
        previousQuantity: 0.1,
        newQuantity: 0.3,
        referenceId: PRODUCT_ID,
        referenceType: 'product_unit_conversion',
      }),
    ])
    expect(remote.calls).toHaveLength(0)
  })
})
