import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { useWorkspacePermissions } from '@/permissions'
import { queryKeys } from '@/query/queryKeys'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { recordWorkspaceDataFetch } from '@/workspace/workspaceDataFreshness'
import { useBusinessPartnerGroupVisibility } from './businessPartnerGroups'
import { fetchDirectCounterparties, type DirectCounterpartyQuery } from './directTransactionCounterparties'
import { fetchDirectTransactionsPage, type DirectTransactionPageQuery } from './directTransactions'

/** One viewer boundary for every counterparty, selected record and payment-page read. */
export function useDirectTransactionReadScope(workspaceId: string | undefined) {
  const { user } = useAuth()
  const { hasFeature, hasCapability } = useWorkspace()
  const permissions = useWorkspacePermissions()
  const viewer = { userId: user?.id, role: user?.role, featureEnabled: hasCapability('businessPartnerGroupPrivacy') }
  const visibility = useBusinessPartnerGroupVisibility(workspaceId, viewer)
  const online = useNetworkStatus()
  const remote = Boolean(workspaceId && online && !isLocalWorkspaceMode(workspaceId))
  const canPost = hasFeature('direct_transactions') && permissions.hasPermission('directTransaction.access')
  const agents = hasFeature('agents') && permissions.hasPermission('agents.access')
  const partners = hasFeature('crm') && permissions.hasPermission('businessPartners.access')
  return {
    remote,
    ready: !permissions.isLoading && !visibility.isLoading && user?.workspaceId === workspaceId,
    canPost, agents, partners,
    key: [user?.id, user?.role, permissions.permissionKeys, visibility.scopeKey,
      hasCapability('workspaceManagementPermissions'), canPost, agents, partners],
  }
}

/** Local reads stay reactive; remote Query data never competes with a persisted Query cache. */
export function useDirectTransactionRead<T>(workspaceId: string | undefined, input: Record<string, unknown>,
  read: (signal?: AbortSignal) => Promise<T>, enabled = true) {
  const scope = useDirectTransactionReadScope(workspaceId)
  const key = JSON.stringify([workspaceId, input, scope.key, scope.remote])
  const active = Boolean(workspaceId && enabled && scope.ready && scope.canPost)
  const remote = useQuery({
    queryKey: [...queryKeys.directTransactions.all(workspaceId), input, scope.key, scope.remote ? 'remote' : 'local'],
    queryFn: ({ signal }) => read(signal),
    enabled: active && scope.remote,
  })
  const [retry, setRetry] = useState(0)
  const local = useLiveQuery(async () => {
    if (!active || scope.remote) return undefined
    try {
      const data = await read()
      for (const table of input.resource === 'transactions' ? ['payment_transactions'] : ['business_partners', 'agents', 'agent_types']) {
        recordWorkspaceDataFetch(workspaceId!, 'local', undefined, table)
      }
      return { key, data, error: null }
    }
    catch (error) { return { key, data: undefined, error } }
  }, [key, active, scope.remote, retry])
  const data = scope.remote ? remote.data : local?.key === key ? local.data : undefined
  const error = scope.remote ? remote.error : local?.key === key ? local.error : null
  return { data: active ? data : undefined,
    isLoading: enabled && (!scope.ready || (active && (scope.remote ? remote.isFetching : !local || local.key !== key))),
    error, scope, refetch: () => scope.remote ? remote.refetch() : setRetry(value => value + 1) }
}


export function useDirectCounterpartyPage(workspaceId: string | undefined, query: DirectCounterpartyQuery, enabled = true) {
  return useDirectTransactionRead(workspaceId, { resource: 'counterparties', ...query },
    signal => fetchDirectCounterparties(workspaceId!, query, signal), enabled)
}

export function useDirectTransactionsPage(workspaceId: string | undefined, query: DirectTransactionPageQuery) {
  return useDirectTransactionRead(workspaceId, { resource: 'transactions', ...query },
    signal => fetchDirectTransactionsPage(workspaceId!, query, signal))
}

