import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { reportStockReservationConflict } from '@/lib/stockReservationConflict'
import type { SalesOrder } from './models'
import type { LocalModeSqliteMutation, SqliteConnection } from './localModeSqlite'

type Position = { workspaceId: string; productId: string; storageId: string; previous: number; next: number; exclude?: string }
const positionKey = (p: Position) => `${p.workspaceId}:${p.productId}:${p.storageId}`

async function reserved(connection: SqliteConnection, p: Position) {
  const rows = await connection.select<{ quantity: number }[]>(`
    SELECT COALESCE(SUM(
      COALESCE(json_extract(line.value,'$.inventoryQuantity'),COALESCE(json_extract(line.value,'$.quantity'),0)*COALESCE(json_extract(line.value,'$.unitFactor'),1))
      + COALESCE(json_extract(line.value,'$.freeBonusInventoryQuantity'),COALESCE(json_extract(line.value,'$.freeBonusQuantity'),json_extract(line.value,'$.freeQuantity'),0)*COALESCE(json_extract(line.value,'$.unitFactor'),1))
    ),0) quantity FROM local_entities orders, json_each(orders.payload,'$.items') line
    WHERE orders.entity_type='sales_orders' AND orders.workspace_id=$1
      AND json_extract(orders.payload,'$.status')='pending' AND COALESCE(json_extract(orders.payload,'$.isDeleted'),0)=0
      AND json_extract(line.value,'$.productId')=$2
      AND (COALESCE(json_extract(line.value,'$.storageId'),json_extract(orders.payload,'$.sourceStorageId'))=$3
        OR COALESCE(json_extract(line.value,'$.storageId'),json_extract(orders.payload,'$.sourceStorageId')) IS NULL)
      AND ($4 IS NULL OR orders.entity_id<>$4)
  `, [p.workspaceId,p.productId,p.storageId,p.exclude ?? null])
  return Number(rows[0]?.quantity ?? 0)
}

/** Run before and after applying a mutation group on the same BEGIN IMMEDIATE connection. */
export async function prepareSqliteReservationValidation(connection: SqliteConnection, mutations: readonly LocalModeSqliteMutation[]) {
  const positions = new Map<string, Position>()
  const increasedReservations: Position[] = []
  for (const mutation of mutations) {
    const row = mutation.row
    const workspaceId = mutation.workspaceId || row.workspaceId
    if (typeof workspaceId !== 'string') continue
    if (mutation.tableName === 'inventory' && typeof row.productId === 'string' && typeof row.storageId === 'string') {
      const p: Position = { workspaceId, productId: row.productId, storageId: row.storageId, previous: 0, next: mutation.type === 'delete' || row.isDeleted ? 0 : Number(row.quantity) }
      const key = positionKey(p)
      const existing = positions.get(key)
      if (existing) { existing.next=p.next; continue }
      const previous = await connection.select<{ payload: string }[]>(
        "SELECT payload FROM local_entities WHERE entity_type='inventory' AND entity_id=$1 AND workspace_id=$2",[row.id,workspaceId])
      if (previous[0]) {
        const value = JSON.parse(previous[0].payload)
        p.previous = value.isDeleted ? 0 : Number(value.quantity || 0)
      }
      positions.set(key,p)
    }
    if (mutation.tableName === 'sales_orders' && mutation.type === 'upsert' && row.status === 'pending' && !row.isDeleted) {
      const previous = await connection.select<{ payload: string }[]>(
        "SELECT payload FROM local_entities WHERE entity_type='sales_orders' AND entity_id=$1 AND workspace_id=$2",[row.id,workspaceId])
      const old = previous[0] ? JSON.parse(previous[0].payload) as SalesOrder : undefined
      const totals = new Map<string, Position>()
      const order = row as unknown as SalesOrder
      for (const item of order.items) {
        const storageId = item.storageId || order.sourceStorageId
        if (!storageId) continue
        const p: Position = { workspaceId,productId:item.productId,storageId,previous:0,next:getOrderLineInventoryQuantity(item),exclude:order.id }
        const key=positionKey(p)
        if (totals.has(key)) totals.get(key)!.next+=p.next
        else totals.set(key,p)
      }
      for (const p of totals.values()) {
        p.previous = old?.status==='pending' && !old.isDeleted ? old.items.filter(item => item.productId===p.productId && (item.storageId || old.sourceStorageId)===p.storageId)
          .reduce((sum,item)=>sum+getOrderLineInventoryQuantity(item),0) : 0
        if (p.next>p.previous+0.0000005) increasedReservations.push(p)
      }
    }
  }
  return async () => {
    for (const p of positions.values()) {
      if (p.next>=p.previous-0.0000005) continue
      const movements = mutations.filter(m => m.tableName==='inventory_transactions' && m.row.productId===p.productId && m.row.storageId===p.storageId)
      if (movements.length && movements.every(m => ['stock_adjustment','inventory_change','initial_stock'].includes(String(m.row.transactionType)))) continue
      const owner = movements.find(m => m.row.transactionType==='sale' && m.row.referenceType==='sales_order')?.row.referenceId
      p.exclude=typeof owner==='string' ? owner : undefined
      const held=await reserved(connection,p)
      if (held>0 && p.next<held-0.0000005) throw reportStockReservationConflict({ ...p,onHand:p.previous,reserved:held,required:p.previous-p.next,available:Math.max(0,p.previous-held) })
    }
    for (const p of increasedReservations) {
      const finalOrder = await connection.select<{ payload: string }[]>("SELECT payload FROM local_entities WHERE entity_type='sales_orders' AND entity_id=$1 AND workspace_id=$2",[p.exclude,p.workspaceId])
      if (!finalOrder[0] || JSON.parse(finalOrder[0].payload).status !== 'pending' || JSON.parse(finalOrder[0].payload).isDeleted) continue
      const product = await connection.select<{ payload: string }[]>("SELECT payload FROM local_entities WHERE entity_type='products' AND entity_id=$1 AND workspace_id=$2",[p.productId,p.workspaceId])
      if (product[0] && JSON.parse(product[0].payload).isService) continue
      const stock = await connection.select<{ quantity: number }[]>(`SELECT COALESCE(MAX(CASE WHEN COALESCE(json_extract(payload,'$.isDeleted'),0)=0 THEN json_extract(payload,'$.quantity') ELSE 0 END),0) quantity
        FROM local_entities WHERE entity_type='inventory' AND workspace_id=$1 AND json_extract(payload,'$.productId')=$2 AND json_extract(payload,'$.storageId')=$3`,[p.workspaceId,p.productId,p.storageId])
      const onHand=Number(stock[0]?.quantity ?? 0)
      const held=await reserved(connection,p)
      if (p.next>onHand-held+0.0000005) throw reportStockReservationConflict({ ...p,onHand,reserved:held,required:p.next,available:Math.max(0,onHand-held) })
    }
  }
}
