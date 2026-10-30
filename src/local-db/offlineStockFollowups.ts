import { supabase } from '@/auth/supabase'
import { getActiveBusinessWorkspaceId, isOnline } from '@/lib/network'
import { db } from './database'
import type { OfflineStockOperation } from './offlineStockOperations'

/** Durable, state-derived follow-ups run only after the stock receipt commits. */
export async function runOfflineStockFollowups(actorId: string) {
  const activeWorkspace = getActiveBusinessWorkspaceId()
  if (!activeWorkspace || !isOnline(activeWorkspace)) return
  const jobs = await db.app_settings.where('key').startsWith(`stock-followup:v1:${activeWorkspace}:${actorId}:`).limit(20).toArray()
  for (const job of jobs) {
    const input = JSON.parse(job.value) as { actorId: string; workspaceId: string; operationId: string; productIds: string[]; orderIds: string[] }
    if (input.actorId !== actorId || (activeWorkspace && input.workspaceId !== activeWorkspace)) continue
    let blocked = false
    await db.offline_mutations.where('workspaceId').equals(input.workspaceId).each(row => {
      if (row.entityType !== 'stock_operations' || row.status === 'synced' || row.status === 'discarded') return
      if ((row.payload as unknown as OfflineStockOperation).effects.some(effect =>
        (effect.table === 'inventory' && input.productIds.includes(String(effect.after?.productId)))
        || (effect.table === 'sales_orders' && input.orderIds.includes(effect.id)))) blocked = true
    })
    if (blocked) continue
    try {
      for (const orderId of input.orderIds) {
        const { error } = await supabase.rpc('reconcile_sales_agent_commission', { p_order_id: orderId, p_order_return_id: null })
        if (error) throw error
      }
      const { evaluateReorderTransferRulesForProduct } = await import('./reorderTransferRules')
      for (const productId of input.productIds) await evaluateReorderTransferRulesForProduct(input.workspaceId, productId, input.operationId)
      await db.app_settings.delete(job.key)
    } catch (error) {
      // Keep the job through restarts. Reorder IDs are stable per operation/rule;
      // commission reconciliation uses the authoritative order state.
      console.warn('[Stock] Confirmed operation follow-up will retry', error)
    }
  }
}
