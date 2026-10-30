import i18n from '@/i18n/config'
import { getActiveBusinessUserId } from '@/lib/network'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { roundQuantity } from '@/lib/quantity'
import { db } from './database'
import { currentStockOperation, type StockOperationEffect } from './offlineStockContext'
import type { StockAvailability, StockPosition } from './stockReservations'
import type { OfflineStockOperation } from './offlineStockOperations'

function key(workspaceId: string, position: StockPosition, excludeOrderId?: string) {
  return `stock-availability:v1:${workspaceId}:${getActiveBusinessUserId() ?? ''}:${position.productId}:${position.storageId}:${excludeOrderId ?? ''}`
}

export async function cacheOfflineStockAvailability(workspaceId: string, rows: readonly StockAvailability[], excludeOrderId?: string) {
  const timestamp = new Date().toISOString()
  await db.app_settings.bulkPut(rows.map(row => ({ workspaceId, key: key(workspaceId, row, excludeOrderId), value: JSON.stringify({ ...row, confirmedAt: timestamp }) })))
}

export async function replaceOfflineStockAvailability(workspaceId: string, rows: readonly StockAvailability[], positions: readonly StockPosition[] = rows) {
  for (const position of positions) {
    const prefix = key(workspaceId, position)
    const keys = await db.app_settings.where('key').startsWith(prefix).primaryKeys()
    await db.app_settings.bulkDelete(keys)
  }
  await cacheOfflineStockAvailability(workspaceId, rows)
}

function reservation(row: Record<string, unknown> | null, position: StockPosition, excludeOrderId?: string) {
  if (!row || row.id === excludeOrderId || row.status !== 'pending' || row.isDeleted || !Array.isArray(row.items)) return 0
  return row.items.reduce((total: number, item) => item.productId === position.productId
    && (item.storageId || row.sourceStorageId) === position.storageId
    ? total + getOrderLineInventoryQuantity(item) : total, 0)
}

/** Server totals include reservations belonging to orders hidden by RLS. */
export async function readOfflineStockAvailability(workspaceId: string, positions: readonly StockPosition[], excludeOrderId?: string): Promise<StockAvailability[]> {
  const operations = await db.offline_mutations.where('workspaceId').equals(workspaceId)
    .filter(row => row.entityType === 'stock_operations' && row.status !== 'synced' && row.status !== 'discarded').toArray()
  const effects: StockOperationEffect[] = operations.flatMap(row => (row.payload as unknown as OfflineStockOperation).effects)
  effects.push(...(currentStockOperation(workspaceId)?.effects.values() ?? []))
  const rows: StockAvailability[] = []
  for (const position of positions) {
    let stored = await db.app_settings.get(key(workspaceId, position, excludeOrderId))
    let ownReservation = 0
    if (!stored && excludeOrderId) {
      stored = await db.app_settings.get(key(workspaceId, position))
      const original = effects.find(effect => effect.table === 'sales_orders' && effect.id === excludeOrderId)?.before
      const order = original ?? await db.sales_orders.get(excludeOrderId) ?? null
      ownReservation = reservation(order as Record<string, unknown> | null, position)
    }
    if (!stored) throw new Error(i18n.t('inventory.offline.prepareRequired'))
    let baseline: StockAvailability
    try { baseline = JSON.parse(stored.value) } catch { throw new Error(i18n.t('inventory.offline.prepareRequired')) }
    if (![baseline.onHand, baseline.reserved, baseline.available].every(Number.isFinite)) throw new Error(i18n.t('inventory.offline.prepareRequired'))
    const delta = effects.filter(effect => effect.table === 'sales_orders').reduce((sum, effect) =>
      sum + reservation(effect.after, position, excludeOrderId) - reservation(effect.before, position, excludeOrderId), 0)
    const reserved = roundQuantity(Math.max(0, baseline.reserved - ownReservation + delta))
    const stockDelta = effects.filter(effect => effect.table === 'inventory' && (effect.after ?? effect.before)?.productId === position.productId && (effect.after ?? effect.before)?.storageId === position.storageId)
      .reduce((sum, effect) => sum + Number(effect.after?.quantity ?? 0) - Number(effect.before?.quantity ?? 0), 0)
    const onHand = roundQuantity(baseline.onHand + stockDelta)
    rows.push({ ...position, onHand, reserved, available: roundQuantity(Math.max(0, onHand - reserved)) })
  }
  return rows
}
