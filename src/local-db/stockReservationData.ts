import { db } from './database'
import { currentStockOperation } from './offlineStockContext'
import { readOfflineStockAvailability } from './offlineStockAvailability'
import { isService, isVirtualStorageId } from '@/lib/catalogItem'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { QUANTITY_EPSILON, roundQuantity } from '@/lib/quantity'
import { reportStockReservationConflict } from '@/lib/stockReservationConflict'
import { isOnline } from '@/lib/network'
import { supabase } from '@/auth/supabase'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { cacheOfflineStockAvailability } from './offlineStockAvailability'
import i18n from '@/i18n/config'
export interface StockPosition { productId: string; storageId: string }
export interface StockAvailability extends StockPosition { onHand: number; reserved: number; available: number }
export interface StockDemand extends StockPosition { quantity: number }
export const stockPositionKey = (position: StockPosition) => `${position.productId}:${position.storageId}`

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class InvalidStockPositionError extends Error {
  constructor() {
    super('Stock availability requires UUID product and storage IDs')
    this.name = 'InvalidStockPositionError'
  }
}

function isVirtualStockPosition(position: StockPosition): boolean {
  return isVirtualStorageId(position.productId) || isVirtualStorageId(position.storageId)
}

function isValidStockPosition(position: StockPosition): boolean {
  return !isVirtualStockPosition(position) && UUID_PATTERN.test(position.productId) && UUID_PATTERN.test(position.storageId)
}

function stockPositionsExcludingVirtual(positions: readonly StockPosition[]): StockPosition[] {
  return positions.filter(position => position.productId && position.storageId && !isVirtualStockPosition(position))
}

export async function fetchStockAvailability(workspaceId: string, positions: readonly StockPosition[], excludeOrderId?: string, signal?: AbortSignal): Promise<StockAvailability[]> {
  const stockPositions = stockPositionsExcludingVirtual(positions)
  if (!stockPositions.length) return []
  if (isLocalWorkspaceMode(workspaceId)) return readLocalStockAvailability(workspaceId, stockPositions, excludeOrderId)
  if (!isOnline(workspaceId) || currentStockOperation(workspaceId)) return readOfflineStockAvailability(workspaceId, stockPositions, excludeOrderId)
  if (stockPositions.some(position => !isValidStockPosition(position))) throw new InvalidStockPositionError()
  const rows: StockAvailability[] = []
  for (let offset = 0; offset < stockPositions.length; offset += 200) {
    let request = supabase.rpc('get_stock_reservation_availability', {
      p_workspace_id: workspaceId, p_positions: stockPositions.slice(offset, offset + 200), p_exclude_order_id: excludeOrderId || null,
    })
    if (signal) request = request.abortSignal(signal)
    const { data, error } = await request
    if (error) throw error
    if (!Array.isArray(data)) throw new Error('Invalid stock availability response')
    for (const row of data) {
      if (!row || typeof row.productId !== 'string' || typeof row.storageId !== 'string'
        || ![row.onHand, row.reserved, row.available].every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('Invalid stock availability row')
      }
      rows.push(row as StockAvailability)
    }
  }
  await cacheOfflineStockAvailability(workspaceId, rows, excludeOrderId)
  return readOfflineStockAvailability(workspaceId, stockPositions, excludeOrderId)
}

export async function assertStockDemands(workspaceId: string, demands: readonly StockDemand[], excludeOrderId?: string) {
  const grouped = new Map<string, StockDemand>()
  for (const demand of demands) {
    if (!demand.productId || !demand.storageId || isVirtualStockPosition(demand)) continue
    const key = stockPositionKey(demand)
    grouped.set(key, { ...demand, quantity: roundQuantity((grouped.get(key)?.quantity ?? 0) + demand.quantity) })
  }
  const positions = await fetchStockAvailability(workspaceId, [...grouped.values()], excludeOrderId)
  if ([...grouped.keys()].some(key => !positions.some(position => stockPositionKey(position) === key))) throw new Error(i18n.t('stockReservations.loadFailed'))
  for (const stock of positions) {
    const required = grouped.get(stockPositionKey(stock))!.quantity
    if (required > stock.onHand - stock.reserved + QUANTITY_EPSILON) {
      throw reportStockReservationConflict({ ...stock, required, workspaceId })
    }
  }
}

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
