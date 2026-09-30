import 'fake-indexeddb/auto'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

const WORKSPACE_ID = 'c8200000-0000-4000-8000-000000000101'
const PRODUCT_ID = 'c8200000-0000-4000-8000-000000000102'
const PRICE_BOOK_ID = 'c8200000-0000-4000-8000-000000000103'

const remote = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; payload: Record<string, unknown>[]; onConflict: string }>,
  error: null as null | { message: string; code?: string },
}))

vi.mock('@/auth/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      upsert: (payload: Record<string, unknown>[], options: { onConflict: string }) => {
        remote.calls.push({ table, payload, onConflict: options.onConflict })
        return {
          select: async () => ({ data: remote.error ? null : payload, error: remote.error }),
        }
      },
    }),
  },
}))

vi.mock('./hooks', () => ({
  fetchTableFromSupabase: vi.fn(async () => true),
}))

let replaceProductPriceBookUomPrices: typeof import('./priceBookUomPrices').replaceProductPriceBookUomPrices

describe('Price Book UoM price persistence', () => {
  beforeAll(async () => {
    installTestBrowser()
    const service = await import('./priceBookUomPrices')
    replaceProductPriceBookUomPrices = service.replaceProductPriceBookUomPrices
  })

  beforeEach(async () => {
    await db.delete()
    await db.open()
    remote.calls = []
    remote.error = null
    setNetworkStatus(true)
    setActiveBusinessWorkspace(WORKSPACE_ID)
    setActiveBusinessUser('c8200000-0000-4000-8000-000000000104', 'admin', WORKSPACE_ID)
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
  })

  afterAll(async () => {
    await db.delete()
    setActiveBusinessUser(null)
    setActiveBusinessWorkspace(null)
    setNetworkStatus(true)
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
  })

  it('stores independent UoM prices and archives removed overrides in Local mode', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    const saved = await replaceProductPriceBookUomPrices(WORKSPACE_ID, PRODUCT_ID, [{
      priceBookId: PRICE_BOOK_ID,
      unitRef: 'builtin:pack',
      price: 8500,
      currency: 'iqd',
    }])
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ productId: PRODUCT_ID, unitRef: 'builtin:pack', price: 8500, currency: 'iqd' })

    const removed = await replaceProductPriceBookUomPrices(WORKSPACE_ID, PRODUCT_ID, [])
    expect(removed).toEqual([])
    expect(await db.price_book_unit_prices.toArray()).toMatchObject([{ isDeleted: true, unitRef: 'builtin:pack' }])
  })

  it('upserts a workspace-scoped Cloud UoM override before updating the cache', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
    const saved = await replaceProductPriceBookUomPrices(WORKSPACE_ID, PRODUCT_ID, [{
      priceBookId: PRICE_BOOK_ID,
      unitRef: 'builtin:box',
      price: 32_000,
      currency: 'iqd',
    }])

    expect(remote.calls).toHaveLength(1)
    expect(remote.calls[0]).toMatchObject({
      table: 'price_book_unit_prices',
      onConflict: 'price_book_id,product_id,unit_ref',
      payload: [expect.objectContaining({
        workspace_id: WORKSPACE_ID,
        product_id: PRODUCT_ID,
        price_book_id: PRICE_BOOK_ID,
        unit_ref: 'builtin:box',
        price: 32_000,
        currency: 'iqd',
      })],
    })
    expect(saved[0]).toMatchObject({ syncStatus: 'synced', unitRef: 'builtin:box', price: 32_000 })
    expect(await db.price_book_unit_prices.where('productId').equals(PRODUCT_ID).count()).toBe(1)
  })

  it('leaves the cache unchanged and rejects negative prices when a Cloud write fails', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
    remote.error = { message: 'permission denied', code: '42501' }

    await expect(replaceProductPriceBookUomPrices(WORKSPACE_ID, PRODUCT_ID, [{
      priceBookId: PRICE_BOOK_ID,
      unitRef: 'builtin:pack',
      price: 8500,
      currency: 'iqd',
    }])).rejects.toThrow()
    expect(await db.price_book_unit_prices.count()).toBe(0)

    await expect(replaceProductPriceBookUomPrices(WORKSPACE_ID, PRODUCT_ID, [{
      priceBookId: PRICE_BOOK_ID,
      unitRef: 'builtin:pack',
      price: -1,
      currency: 'iqd',
    }])).rejects.toThrow('price_book_uom_price_invalid')
  })
})
