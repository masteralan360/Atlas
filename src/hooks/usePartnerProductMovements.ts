import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  db, useAgents, useAgentProductCommissionEntries, useBusinessPartner, useLoans, usePurchaseOrders,
  useSales, useSalesOrders, useSalesOrderAgentAssignments, useSalesOrderReturnsForWorkspace,
  useSalesOrderReturnItemsForWorkspace
} from '@/local-db'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { useStorageAccess } from '@/local-db/storagePermissions'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import type { PartnerAccountStatementPeriod } from '@/lib/partnerAccountStatement'
import type { PartnerProductMovementsData } from '@/lib/partnerProductMovements'
import { refreshPartnerProductMovementsLiveData, type ProductMovementsRefreshProgress } from '@/lib/partnerProductMovementsLiveData'

export function usePartnerProductMovements(workspaceId: string | undefined, partnerId: string | null, period: PartnerAccountStatementPeriod) {
  const online = useNetworkStatus()
  const storageAccess = useStorageAccess(workspaceId)
  const partnerRecord = useBusinessPartner(partnerId || undefined)
  const agents = useAgents(workspaceId)
  const commissions = useAgentProductCommissionEntries(workspaceId)
  const assignments = useSalesOrderAgentAssignments(workspaceId)
  // Keep the same source-level view-own visibility as the existing statement.
  const salesOrders = useSalesOrders(workspaceId)
  const purchaseOrders = usePurchaseOrders(workspaceId)
  const sales = useSales(workspaceId)
  const loans = useLoans(workspaceId)
  const orderReturns = useSalesOrderReturnsForWorkspace(workspaceId)
  const orderReturnItems = useSalesOrderReturnItemsForWorkspace(workspaceId)
  const records = useLiveQuery(async () => {
    if (!workspaceId || !partnerId) return null
    const [saleItems, saleReturns, saleReturnItems, exchanges, products, inventoryTransactions] = await Promise.all([
      db.sale_items.where('workspaceId').equals(workspaceId).toArray(),
      db.sale_returns.where('workspaceId').equals(workspaceId).toArray(),
      db.sale_return_items.where('workspaceId').equals(workspaceId).toArray(),
      db.sale_product_exchanges.where('workspaceId').equals(workspaceId).toArray(),
      db.products.where('workspaceId').equals(workspaceId).toArray(),
      db.inventory_transactions.where('workspaceId').equals(workspaceId).toArray()
    ])
    return { saleItems, saleReturns, saleReturnItems, exchanges, products, inventoryTransactions }
  }, [workspaceId, partnerId])
  const [generation, setGeneration] = useState(0)
  const refreshKey = workspaceId && partnerId && online && !isLocalWorkspaceMode(workspaceId) ? `${workspaceId}:${partnerId}:${generation}` : null
  const [refresh, setRefresh] = useState<{ key: string | null; status: 'loading' | 'ready' | 'error'; progress: ProductMovementsRefreshProgress | null }>({ key: null, status: 'ready', progress: null })
  useEffect(() => {
    if (!refreshKey || !workspaceId) return
    const controller = new AbortController()
    setRefresh({ key: refreshKey, status: 'loading', progress: null })
    void refreshPartnerProductMovementsLiveData(workspaceId, {
      signal: controller.signal,
      onProgress: progress => { if (!controller.signal.aborted) setRefresh({ key: refreshKey, status: 'loading', progress }) }
    }).then(() => {
      if (!controller.signal.aborted) setRefresh(current => ({ ...current, key: refreshKey, status: 'ready' }))
    }).catch(() => {
      if (!controller.signal.aborted) setRefresh(current => ({ ...current, key: refreshKey, status: 'error' }))
    })
    return () => controller.abort()
  }, [refreshKey, workspaceId])
  const partner = partnerRecord && partnerRecord.workspaceId === workspaceId && !partnerRecord.isDeleted ? partnerRecord : undefined
  const statementData = useMemo<PartnerProductMovementsData | null>(() => partner && workspaceId && records && storageAccess.isReady !== false ? {
    workspaceId, partnerId: partner.id, agentIds: agents.filter(agent => !agent.isDeleted && agent.agentType === 'field_agent' && agent.businessPartnerId === partner.id).map(agent => agent.id),
    period, salesOrders, purchaseOrders, commissions, assignments, orderReturns, orderReturnItems, loans, sales, ...records, canAccessStorage: storageAccess.canAccessStorage
  } : null, [partner, workspaceId, records, agents, period, salesOrders, purchaseOrders, commissions, assignments, orderReturns, orderReturnItems, loans, sales, storageAccess])
  return {
    partner, statementData,
    isRefreshing: !!partnerId && (!records || storageAccess.isReady === false || !!refreshKey && (refresh.key !== refreshKey || refresh.status === 'loading')),
    refreshError: refreshKey === refresh.key && refresh.status === 'error',
    liveRefreshProgress: refresh.progress,
    retryLiveRefresh: useCallback(() => setGeneration(value => value + 1), [])
  }
}
