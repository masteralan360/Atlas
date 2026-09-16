import { db, fetchTableFromSupabase, syncSalesFromSupabase } from '@/local-db'
import {
  cancelWorkspaceDataHydration, completeWorkspaceDataHydration, failWorkspaceDataHydration,
  readWorkspaceDataHydration, recordWorkspaceDataFetch, startWorkspaceDataHydration,
  updateWorkspaceDataHydrationProgress
} from '@/workspace/workspaceDataFreshness'

export const PARTNER_PRODUCT_MOVEMENTS_LIVE_TABLE_NAMES = [
  'business_partners', 'agents', 'sales_order_agent_assignments', 'agent_product_commission_entries',
  'sales_orders', 'order_returns', 'order_return_items', 'purchase_orders', 'loans',
  'products', 'inventory_transactions'
] as const
// This module-owned completion marker prevents an unrelated source refresh from
// claiming that a statement built from several tables is up to date.
export const PARTNER_PRODUCT_MOVEMENTS_FRESHNESS_TABLE_NAMES = [
  'partner_product_movements_statement', ...PARTNER_PRODUCT_MOVEMENTS_LIVE_TABLE_NAMES, 'sales'
] as const
export type ProductMovementsRefreshProgress = { completedSources: number; totalSources: number }

export async function refreshPartnerProductMovementsLiveData(
  workspaceId: string,
  options: { signal?: AbortSignal; onProgress?: (progress: ProductMovementsRefreshProgress) => void } = {}
) {
  const tableName = PARTNER_PRODUCT_MOVEMENTS_FRESHNESS_TABLE_NAMES[0]
  const operationId = crypto.randomUUID()
  const totalSources = PARTNER_PRODUCT_MOVEMENTS_LIVE_TABLE_NAMES.length + 1
  let completedSources = 0
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new DOMException('Refresh cancelled', 'AbortError')
  }
  checkCancelled()
  startWorkspaceDataHydration(workspaceId, 'supabase', tableName, operationId)
  const cancel = () => cancelWorkspaceDataHydration(workspaceId, 'supabase', tableName, operationId)
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    options.onProgress?.({ completedSources, totalSources })
    const results = await Promise.allSettled([
      ...PARTNER_PRODUCT_MOVEMENTS_LIVE_TABLE_NAMES.map(async name => {
        checkCancelled()
        const complete = await fetchTableFromSupabase(name, db[name], workspaceId)
        checkCancelled()
        if (!complete) throw new Error('Movement source unavailable')
        completedSources += 1
        updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', tableName, completedSources, operationId)
        options.onProgress?.({ completedSources, totalSources })
      }),
      (async () => {
        checkCancelled()
        await syncSalesFromSupabase(workspaceId)
        checkCancelled()
        if (readWorkspaceDataHydration(workspaceId, 'supabase', ['sales'])?.lastResult?.state === 'error') throw new Error('Sales unavailable')
        completedSources += 1
        updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', tableName, completedSources, operationId)
        options.onProgress?.({ completedSources, totalSources })
      })()
    ])
    checkCancelled()
    if (results.some(result => result.status === 'rejected')) throw new Error('Movement sources unavailable')
    recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, tableName)
    completeWorkspaceDataHydration(workspaceId, 'supabase', tableName, undefined, operationId)
  } catch (error) {
    if (options.signal?.aborted) cancel()
    else failWorkspaceDataHydration(workspaceId, 'supabase', tableName, undefined, operationId)
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancel)
  }
}
