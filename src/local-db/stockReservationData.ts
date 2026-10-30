import { db } from './database'
import { currentStockOperation } from './offlineStockContext'
import { readOfflineStockAvailability } from './offlineStockAvailability'
import { isService } from '@/lib/catalogItem'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { QUANTITY_EPSILON, roundQuantity } from '@/lib/quantity'
import { reportStockReservationConflict } from '@/lib/stockReservationConflict'
import type { StockPosition, StockAvailability, StockDemand } from './stockReservations'
const stockPositionKey = (position: StockPosition) => `${position.productId}:${position.storageId}`

/** Indexed pending-order cursor: only requested products are accumulated; no full order array is retained. */
export async function readLocalStockAvailability(workspaceId: string, positions: readonly StockPosition[], excludeOrderId?: string) {
  if (!positions.length) return []
  const result = new Map<string, StockAvailability>()
  const productRows = await db.products.bulkGet([...new Set(positions.map(position => position.productId))])
  const products = new Set(productRows.filter(product => product && product.workspaceId === workspaceId && !isService(product)).map(product => product!.id))
  for (const position of positions) {
    if (!products.has(position.productId)) continue
    const row = await db.inventory.where('[productId+storageId]').equals([position.productId, position.storageId])
      .and(row => row.workspaceId === workspaceId && !row.isDeleted).first()
    result.set(stockPositionKey(position), { ...position, onHand: row?.quantity ?? 0, reserved: 0, available: row?.quantity ?? 0 })
  }
  if (!result.size) return []
  await db.sales_orders.where('[workspaceId+status]').equals([workspaceId, 'pending']).each(order => {
    if (order.isDeleted || order.id === excludeOrderId) return
    for (const item of order.items) {
      if (!products.has(item.productId)) continue
      const storageId = item.storageId || order.sourceStorageId
      for (const position of result.values()) {
        if (position.productId === item.productId && (!storageId || position.storageId === storageId)) {
          position.reserved = roundQuantity(position.reserved + getOrderLineInventoryQuantity(item))
        }
      }
    }
  })
  for (const position of result.values()) position.available = roundQuantity(Math.max(0, position.onHand - position.reserved))
  return [...result.values()]
}


export async function assertLocalStockDemands(workspaceId: string, demands: readonly StockDemand[], excludeOrderId?: string) {
  const grouped = new Map<string, StockDemand>()
  for (const demand of demands) {
    const product = await db.products.get(demand.productId)
    if (product && isService(product)) continue
    const key = stockPositionKey(demand)
    const previous = grouped.get(key)
    grouped.set(key, { ...demand, quantity: roundQuantity((previous?.quantity ?? 0) + demand.quantity) })
  }
  const availability = await (currentStockOperation(workspaceId)
    ? readOfflineStockAvailability(workspaceId, [...grouped.values()], excludeOrderId)
    : readLocalStockAvailability(workspaceId, [...grouped.values()], excludeOrderId))
  for (const position of availability) {
    const required = grouped.get(stockPositionKey(position))!.quantity
    if ((position.reserved > 0 || currentStockOperation(workspaceId)) && required > position.onHand - position.reserved + QUANTITY_EPSILON) {
      const product = await db.products.get(position.productId)
      throw reportStockReservationConflict({ ...position, workspaceId, required, productName: product?.name })
    }
  }
}
