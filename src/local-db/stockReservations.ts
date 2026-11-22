import { useMemo } from 'react'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { readOfflineStockAvailability } from './offlineStockAvailability'
import { useLiveQuery } from 'dexie-react-hooks'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/auth/supabase'
import { useOptionalAuth } from '@/auth'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { isVirtualStorageId } from '@/lib/catalogItem'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { QUANTITY_EPSILON, roundQuantity } from '@/lib/quantity'
import { assertStockDemands, fetchStockAvailability, readLocalStockAvailability, stockPositionKey } from './stockReservationData'
import type { StockAvailability, StockDemand, StockPosition } from './stockReservationData'
export { assertStockDemands, fetchStockAvailability, stockPositionKey } from './stockReservationData'
export type { StockAvailability, StockDemand, StockPosition } from './stockReservationData'
import { queryKeys } from '@/query/queryKeys'
import { db } from './database'
import i18n from '@/i18n/config'
import { canAccessOrderForStorageAccess, getCurrentStorageAccess, useStorageAccess } from './storagePermissions'
import { useOptionalWorkspacePermissions } from '@/permissions/workspacePermissionsState'
import { useViewOwnRecordScope } from '@/permissions/useViewOwnRecordScope'

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

function stockPositionsExcludingVirtual(positions: readonly StockPosition[]): StockPosition[] {
  return positions.filter(position => position.productId && position.storageId && !isVirtualStockPosition(position))
}

function isValidStockPosition(position: StockPosition): boolean {
  return !isVirtualStockPosition(position) && UUID_PATTERN.test(position.productId) && UUID_PATTERN.test(position.storageId)
}

function isNonRetryableStockAvailabilityError(error: unknown): boolean {
  if (error instanceof InvalidStockPositionError) return true
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = error.code
  return typeof code === 'string'
    && (code.startsWith('22') || code.startsWith('23') || code.startsWith('42') || code === 'P0001' || code.startsWith('PGRST'))
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
    if (isVirtualStockPosition(demand)) continue
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
  const online = useNetworkStatus()
  const user = useOptionalAuth()?.user
  const permissions = useOptionalWorkspacePermissions()
  const storageAccess = useStorageAccess(workspaceId)
  const permissionScope = `${storageAccess.signature}:${permissions?.permissionKeys.join(',') ?? ''}`
  const signature = JSON.stringify([...new Map(stockPositionsExcludingVirtual(positions).map(p => [stockPositionKey(p), { productId: p.productId, storageId: p.storageId }])).values()]
    .sort((a, b) => stockPositionKey(a).localeCompare(stockPositionKey(b))))
  const scopedPositions = useMemo(() => JSON.parse(signature) as StockPosition[], [signature])
  const local = !!workspaceId && (isLocalWorkspaceMode(workspaceId) || !online)
  const localResult = useLiveQuery(async () => {
    if (!local || !workspaceId) return { rows: [] as StockAvailability[], error: null }
    try {
      return { rows: await (isLocalWorkspaceMode(workspaceId) ? readLocalStockAvailability(workspaceId, scopedPositions, excludeOrderId) : readOfflineStockAvailability(workspaceId, scopedPositions, excludeOrderId)), error: null }
    } catch (error) { return { rows: undefined, error: error instanceof Error ? error : new Error(i18n.t('inventory.offline.prepareRequired')) } }
  }, [workspaceId, signature, excludeOrderId, local])
  const query = useQuery({
    queryKey: [...queryKeys.stockReservations.availability(workspaceId, scopedPositions, excludeOrderId, user?.id, user?.role), permissionScope],
    queryFn: ({ signal }) => fetchBatchedAvailability(workspaceId!, scopedPositions, excludeOrderId, signal),
    enabled: !!workspaceId && !local && scopedPositions.length > 0,
    staleTime: 5000,
    retry: (failureCount, error) => !isNonRetryableStockAvailabilityError(error) && failureCount < 1,
    refetchInterval: query => isNonRetryableStockAvailabilityError(query.state.error) ? false : 15000,
  })
  return { ...query, data: local ? localResult?.rows : query.data, error: local ? localResult?.error ?? null : query.error, isLoading: local ? localResult === undefined : query.isLoading }
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
    if (isVirtualStockPosition(position)) return { total: 0, rows: [] }
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
    }, enabled: enabled && !local && isValidStockPosition(position),
  })
  return { data: local ? localPage : remote.data, isLoading: local ? localPage === undefined : remote.isFetching, error: remote.error }
}

