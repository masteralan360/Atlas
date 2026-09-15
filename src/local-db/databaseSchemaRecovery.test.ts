import 'fake-indexeddb/auto'

import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'

import { AtlasDatabase } from './database'

const DATABASE_NAME = 'AtlasDatabaseSaleReturnSchemaRecoveryTest'

describe('sale return schema recovery', () => {
  afterEach(async () => {
    await Dexie.delete(DATABASE_NAME)
  })

  it('repairs a current-version cache that is missing POS return stores without losing existing rows', async () => {
    const legacyCache = new Dexie(DATABASE_NAME)
    legacyCache.version(127).stores({ sales: 'id' })
    await legacyCache.open()
    await legacyCache.table('sales').put({ id: 'existing-pos-sale', totalAmount: 100 })
    legacyCache.close()

    const repairedCache = new AtlasDatabase(DATABASE_NAME)
    try {
      await repairedCache.open()

      expect(await repairedCache.sales.get('existing-pos-sale')).toMatchObject({
        id: 'existing-pos-sale',
        totalAmount: 100
      })

      await repairedCache.transaction('rw', [repairedCache.sale_returns, repairedCache.sale_return_items], async () => {
        await repairedCache.sale_returns.put({
          id: 'return-1',
          workspaceId: 'workspace-1',
          saleId: 'existing-pos-sale',
          status: 'posted',
          returnedAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z'
        } as never)
        await repairedCache.sale_return_items.put({
          id: 'return-item-1',
          workspaceId: 'workspace-1',
          returnId: 'return-1',
          saleId: 'existing-pos-sale',
          saleItemId: 'sale-item-1',
          updatedAt: '2026-09-15T00:00:00.000Z'
        } as never)
      })

      expect(await repairedCache.sale_returns.get('return-1')).toMatchObject({ saleId: 'existing-pos-sale' })
      expect(await repairedCache.sale_return_items.get('return-item-1')).toMatchObject({ returnId: 'return-1' })
    } finally {
      repairedCache.close()
    }
  }, 10_000)
})
