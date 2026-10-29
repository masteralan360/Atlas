import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/auth/supabase'
import { useOptionalAuth } from '@/auth'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { QUANTITY_EPSILON, roundQuantity } from '@/lib/quantity'
import { reportStockReservationConflict } from '@/lib/stockReservationConflict'
import { readLocalStockAvailability } from './stockReservationData'
import { queryKeys } from '@/query/queryKeys'
import { db } from './database'
import i18n from '@/i18n/config'
import { canAccessOrderForStorageAccess, getCurrentStorageAccess, useStorageAccess } from './storagePermissions'
import { useOptionalWorkspacePermissions } from '@/permissions/workspacePermissionsState'
import { useViewOwnRecordScope } from '@/permissions/useViewOwnRecordScope'

export interface StockPosition { productId: string; storageId: string }
export interface StockAvailability extends StockPosition { onHand: number; reserved: number; available: number }
export interface StockDemand extends StockPosition { quantity: number }
export const stockPositionKey = (position: StockPosition) => `${position.productId}:${position.storageId}`

export async function fetchStockAvailability(workspaceId: string, positions: readonly StockPosition[], excludeOrderId?: string, signal?: AbortSignal): Promise<StockAvailability[]> {
  if (!positions.length) return []
  if (isLocalWorkspaceMode(workspaceId)) return readLocalStockAvailability(workspaceId, positions, excludeOrderId)
  const rows: StockAvailability[] = []
  for (let offset = 0; offset < positions.length; offset += 200) {
    let request = supabase.rpc('get_stock_reservation_availability', {
      p_workspace_id: workspaceId, p_positions: positions.slice(offset, offset + 200), p_exclude_order_id: excludeOrderId || null,
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
  return rows
}

export async function assertStockDemands(workspaceId: string, demands: readonly StockDemand[], excludeOrderId?: string) {
  const grouped = new Map<string, StockDemand>()
  for (const demand of demands) {
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

/** Coalesce simultaneously mounted catalog cards into bounded remote requests. */
type AvailabilityWaiter = { workspaceId: string; positions: readonly StockPosition[]; excludeOrderId?: string; signal?: AbortSignal; resolve: (rows: StockAvailability[]) => void; reject: (error: unknown) => void }
let availabilityWaiters: AvailabilityWaiter[] = []
let batchScheduled = false
function fetchBatchedAvailability(workspaceId: string, positions: readonly StockPosition[], excludeOrderId?: string, signal?: AbortSignal) {
  return new Promise<StockAvailability[]>((resolve, reject) => {
    availabilityWaiters.push({ workspaceId, positions, excludeOrderId, signal, resolve, reject })
    if (batchScheduled) return
    batchScheduled = true
    setTimeout(() => {
      batchScheduled = false
      const waiters = availabilityWaiters
      availabilityWaiters = []
      const groups = new Map<string, AvailabilityWaiter[]>()
      for (const waiter of waiters) {
        if (waiter.signal?.aborted) { waiter.reject(new DOMException('Aborted', 'AbortError')); continue }
        const key = `${waiter.workspaceId}:${waiter.excludeOrderId ?? ''}`
        groups.set(key, [...(groups.get(key) ?? []), waiter])
      }
      for (const group of groups.values()) {
        const controller = new AbortController()
        const abort = () => { if (group.every(waiter => waiter.signal?.aborted)) controller.abort() }
        group.forEach(waiter => waiter.signal?.addEventListener('abort', abort, { once: true }))
        const positions = [...new Map(group.flatMap(waiter => waiter.positions).map(p => [stockPositionKey(p), p])).values()]
        void fetchStockAvailability(group[0].workspaceId, positions, group[0].excludeOrderId, controller.signal)
          .then(rows => group.forEach(waiter => {
            const keys = new Set(waiter.positions.map(stockPositionKey))
            waiter.resolve(rows.filter(row => keys.has(stockPositionKey(row))))
          }), error => group.forEach(waiter => waiter.reject(error)))
          .finally(() => group.forEach(waiter => waiter.signal?.removeEventListener('abort', abort)))
      }
    }, 0)
  })
}

export function useStockDemandGuard(workspaceId: string | undefined, demands: readonly StockDemand[], excludeOrderId?: string) {
  const grouped = new Map<string, StockDemand>()
  for (const demand of demands) {
    if (!demand.productId || !demand.storageId) continue
    const key = stockPositionKey(demand)
    grouped.set(key, { ...demand, quantity: roundQuantity((grouped.get(key)?.quantity ?? 0) + demand.quantity) })
  }
  const availability = useStockAvailability(workspaceId, [...grouped.values()], excludeOrderId)
  const conflicts = availability.data?.filter(stock => (grouped.get(stockPositionKey(stock))?.quantity ?? 0) > stock.available + QUANTITY_EPSILON) ?? []
  const hasAvailabilityGap = [...grouped.keys()].some(key => !availability.data?.some(position => stockPositionKey(position) === key))
  return { ...availability, conflicts, hasAvailabilityGap, requiredByPosition: new Map([...grouped].map(([key, demand]) => [key, demand.quantity])), blocked: grouped.size > 0 && (availability.isLoading || !!availability.error || hasAvailabilityGap || conflicts.length > 0),
    assert: () => workspaceId ? assertStockDemands(workspaceId, [...grouped.values()], excludeOrderId) : Promise.resolve() }
}

export function useStockAvailability(workspaceId: string | undefined, positions: readonly StockPosition[], excludeOrderId?: string) {
  const user = useOptionalAuth()?.user
  const permissions = useOptionalWorkspacePermissions()
  const storageAccess = useStorageAccess(workspaceId)
  const permissionScope = `${storageAccess.signature}:${permissions?.permissionKeys.join(',') ?? ''}`
  const signature = JSON.stringify([...new Map(positions.filter(p => p.productId && p.storageId).map(p => [stockPositionKey(p), { productId: p.productId, storageId: p.storageId }])).values()]
    .sort((a, b) => stockPositionKey(a).localeCompare(stockPositionKey(b))))
  const scopedPositions = useMemo(() => JSON.parse(signature) as StockPosition[], [signature])
  const local = !!workspaceId && isLocalWorkspaceMode(workspaceId)
  const localRows = useLiveQuery(() => local && workspaceId ? readLocalStockAvailability(workspaceId, scopedPositions, excludeOrderId) : [], [workspaceId, signature, excludeOrderId, local])
  const query = useQuery({
    queryKey: [...queryKeys.stockReservations.availability(workspaceId, scopedPositions, excludeOrderId, user?.id, user?.role), permissionScope],
    queryFn: ({ signal }) => fetchBatchedAvailability(workspaceId!, scopedPositions, excludeOrderId, signal),
    enabled: !!workspaceId && !local && scopedPositions.length > 0,
    staleTime: 5000,
    refetchInterval: 15000,
  })
  return { ...query, data: local ? localRows : query.data, isLoading: local ? localRows === undefined : query.isLoading }
}

export interface VisibleStockReservation { id: string; order_number: string; created_at: string; quantity: number }
export interface VisibleStockReservationsPage { total: number; rows: VisibleStockReservation[] }

export function useVisibleStockReservations(workspaceId: string, position: StockPosition, page: number, enabled: boolean) {
  const user = useOptionalAuth()?.user
  const permissions = useOptionalWorkspacePermissions()
  const own = useViewOwnRecordScope('orders.view_own')
  const access = useStorageAccess(workspaceId)
  const scope = `${access.signature}:${permissions?.permissionKeys.join(',') ?? ''}:${own.isRestricted}`
  const local = isLocalWorkspaceMode(workspaceId)
  const localPage = useLiveQuery(async (): Promise<VisibleStockReservationsPage | undefined> => {
    if (!enabled || !local) return undefined
    if (user?.role !== 'admin' && !permissions?.permissionKeys.includes('orders.saleOrdersAccess')) return { total: 0, rows: [] }
    const storageAccess = await getCurrentStorageAccess(workspaceId)
    let total = 0
    const rows: VisibleStockReservation[] = []
    // Keep only the requested page while traversing the indexed active scope.
    await db.sales_orders.where('[workspaceId+status]').equals([workspaceId, 'pending']).each(order => {
        if (order.isDeleted || (own.isRestricted && order.createdBy !== user?.id) || !canAccessOrderForStorageAccess(order, storageAccess)) return
        const quantity = order.items.filter(item => item.productId === position.productId
          && (!(item.storageId || order.sourceStorageId) || (item.storageId || order.sourceStorageId) === position.storageId))
          .reduce((sum, item) => sum + getOrderLineInventoryQuantity(item), 0)
        if (quantity <= 0) return
        if (total >= (page - 1) * 20 && rows.length < 20) rows.push({ id: order.id, order_number: order.orderNumber, created_at: order.createdAt, quantity })
        total++
    })
    return { total, rows }
  }, [workspaceId, position.productId, position.storageId, page, enabled, local, user?.id, scope])
  const remote = useQuery({
    queryKey: [...queryKeys.stockReservations.details(workspaceId, position.productId, position.storageId, page, user?.id, user?.role), scope],
    queryFn: async ({ signal }): Promise<VisibleStockReservationsPage> => {
      const { data, error } = await supabase.rpc('get_visible_stock_reservations', {
        p_workspace_id: workspaceId, p_product_id: position.productId, p_storage_id: position.storageId, p_offset: (page - 1) * 20,
      }).abortSignal(signal)
      if (error) throw error
      if (!data || !Array.isArray(data.rows) || !Number.isInteger(data.total) || data.total < 0
        || !data.rows.every((row: VisibleStockReservation) => row && typeof row.id === 'string'
          && typeof row.order_number === 'string' && typeof row.created_at === 'string'
          && typeof row.quantity === 'number' && Number.isFinite(row.quantity) && row.quantity >= 0)) throw new Error('Invalid reservation page')
      return data as VisibleStockReservationsPage
    }, enabled: enabled && !local,
  })
  return { data: local ? localPage : remote.data, isLoading: local ? localPage === undefined : remote.isFetching, error: remote.error }
}

