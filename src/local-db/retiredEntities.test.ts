import 'fake-indexeddb/auto'

import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'

import { AtlasDatabase } from './database'
import { RETIRED_ENTITY_TYPES, isRetiredEntityType } from './retiredEntities'

const DATABASE_NAME = 'AtlasRetiredEntityUpgradeTest'

afterEach(async () => {
  await Dexie.delete(DATABASE_NAME)
})

describe('retired operational data upgrade', () => {
  it('removes retired stores and retries while retaining payments and account movements', async () => {
    const template = new AtlasDatabase('AtlasRetirementSchemaTemplate')
    const stores: Record<string, string> = Object.fromEntries(template.tables.map((table) => [
      table.name,
      [table.schema.primKey.src, ...table.schema.indexes.map((index) => index.src)].join(', '),
    ]))
    template.close()
    for (const entityType of RETIRED_ENTITY_TYPES) {
      if (entityType !== 'delivery_voice_cleanup') stores[entityType] = 'id, workspaceId'
    }
    const legacy = new Dexie(DATABASE_NAME)
    legacy.version(160).stores(stores)
    await legacy.open()
    await legacy.table('delivery_shipments').put({ id: 'shipment-1', workspaceId: 'workspace-1' })
    await legacy.table('delivery_shipment_prepaid_corrections').put({ id: 'correction-1' })
    await legacy.table('workspaces').put({ id: 'workspace-1', post_service: true })
    await legacy.table('agents').put({ id: 'courier-1', courierDeliveryFee: 5 })
    await legacy.table('offline_mutations').bulkPut([
      { id: 'retired-write', entityType: 'delivery_shipments', entityId: 'shipment-1' },
      { id: 'retired-voice', entityType: 'delivery_voice_cleanup', entityId: 'shipment-1' },
      { id: 'payment-write', entityType: 'payment_transactions', entityId: 'payment-1' },
    ])
    await legacy.table('syncQueue').bulkPut([
      { id: 'retired-sync', entityType: 'delivery_settlements', entityId: 'settlement-1' },
      { id: 'sales-sync', entityType: 'sales', entityId: 'sale-1' },
    ])
    const payment = { id: 'payment-1', sourceType: 'delivery_merchant_payout', amount: 25 }
    const movement = { id: 'movement-1', paymentTransactionId: 'payment-1', amount: 25 }
    await legacy.table('payment_transactions').put(payment)
    await legacy.table('payment_account_movements').put(movement)
    legacy.close()

    const upgraded = new AtlasDatabase(DATABASE_NAME)
    try {
      await upgraded.open()
      expect(upgraded.tables.some((table) => isRetiredEntityType(table.name))).toBe(false)
      expect(await upgraded.offline_mutations.toArray()).toEqual([
        expect.objectContaining({ id: 'payment-write' }),
      ])
      expect(await upgraded.syncQueue.toArray()).toEqual([
        expect.objectContaining({ entityType: 'sales' }),
      ])
      expect(await upgraded.payment_transactions.get('payment-1')).toEqual(payment)
      expect(await upgraded.payment_account_movements.get('movement-1')).toEqual(movement)
      expect(await upgraded.workspaces.get('workspace-1')).not.toHaveProperty('post_service')
      expect(await upgraded.agents.get('courier-1')).not.toHaveProperty('courierDeliveryFee')
    } finally {
      upgraded.close()
    }
  }, 30_000)

  it('keeps marketplace delivery, payments and shared agent entities active', () => {
    for (const entityType of ['marketplace_delivery_product', 'agents', 'sales_orders', 'payment_transactions']) {
      expect(isRetiredEntityType(entityType)).toBe(false)
    }
  })
})
