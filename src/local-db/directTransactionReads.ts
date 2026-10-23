import { queryKeys } from '@/query/queryKeys'
import { queryClient } from '@/query/queryClient'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { startWorkspaceDataHydration, updateWorkspaceDataHydrationProgress, completeWorkspaceDataHydration,
  failWorkspaceDataHydration, cancelWorkspaceDataHydration, recordWorkspaceDataFetch } from '@/workspace/workspaceDataFreshness'

export function invalidateDirectTransactions(workspaceId: string) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.directTransactions.all(workspaceId) })
}

export async function readDirectTransactionRpc<TRaw, TResult = TRaw>(workspaceId: string, rpc: string, args: Record<string, unknown>,
  tables: string[], signal?: AbortSignal, normalize?: (raw: TRaw) => Promise<TResult>): Promise<TResult> {
  const operationId = crypto.randomUUID()
  for (const table of tables) startWorkspaceDataHydration(workspaceId, 'supabase', table, operationId)
  try {
    const client = getSupabaseClientForTable('business_partners')
    const result = await runSupabaseAction(`directTransactions.${rpc}`, () =>
      client.rpc(rpc, { p_workspace_id: workspaceId, ...args }), { signal })
    if (result.error) throw result.error
    signal?.throwIfAborted()
    if (!result.data || typeof result.data !== 'object') throw new Error('Invalid direct transaction response')
    const data = normalize ? await normalize(result.data as TRaw) : result.data as TResult
    signal?.throwIfAborted()
    for (const table of tables) {
      updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', table,
        Array.isArray((data as { items?: unknown[] }).items) ? (data as { items: unknown[] }).items.length : 1, operationId)
      recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, table)
      completeWorkspaceDataHydration(workspaceId, 'supabase', table, undefined, operationId)
    }
    return data
  } catch (error) {
    for (const table of tables) {
      if (signal?.aborted) cancelWorkspaceDataHydration(workspaceId, 'supabase', table, operationId)
      else failWorkspaceDataHydration(workspaceId, 'supabase', table, undefined, operationId)
    }
    throw error
  }
}

export function usesRemoteDirectTransactions(workspaceId: string) {
  return isOnline(workspaceId) && !isLocalWorkspaceMode(workspaceId)
}
