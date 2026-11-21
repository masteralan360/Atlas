import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  getWorkspacePaymentSummary,
  getWorkspacePaygSummary,
  WORKSPACE_PAYMENT_UPDATED_EVENT,
  type WorkspacePaygSummary,
  type WorkspacePaymentSummary,
} from '@/lib/workspacePayments'
import { getWorkspaceUsageStatus, type WorkspaceUsageStatus } from '@/lib/workspaceUsage'
import {
  saveWorkspaceUsageSnapshot,
  type WorkspaceUsageLocalHistory,
} from '@/lib/workspaceUsageHistory'
import {
  cancelWorkspaceDataHydration,
  completeWorkspaceDataHydration,
  failWorkspaceDataHydration,
  recordWorkspaceDataFetch,
  startWorkspaceDataHydration,
  updateWorkspaceDataHydrationProgress,
} from '@/workspace/workspaceDataFreshness'
import { queryKeys } from '@/query/queryKeys'

export const WORKSPACE_PAYMENT_FRESHNESS_TABLES = [
  'billing.workspace_payment_configurations',
  'billing.payment_transactions',
  'billing.payg_cycles',
  'billing.workspace_payg_limits',
  'public.workspace_usage',
  'public.workspace_usage_limits',
] as const

export interface WorkspacePaymentOverview {
  paymentSummary: WorkspacePaymentSummary
  paygSummary: WorkspacePaygSummary
  usageStatus: WorkspaceUsageStatus | null
  usageHistory: WorkspaceUsageLocalHistory | null
}

export interface WorkspacePaymentOverviewScope {
  workspaceId: string
  userId: string
  role: string
}

function createOperationId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function readWithFreshness<T>(options: {
  workspaceId: string
  signal: AbortSignal
  operationId: string
  tableNames: readonly string[]
  read: () => Promise<T>
  getRecordsFetched: (value: T) => number
}): Promise<T> {
  const { workspaceId, signal, operationId, tableNames, read, getRecordsFetched } = options
  const source = 'supabase' as const

  tableNames.forEach((tableName) => {
    startWorkspaceDataHydration(workspaceId, source, tableName, operationId)
  })

  try {
    const value = await read()
    if (signal.aborted) throw signal.reason ?? new Error('The request was aborted')

    const fetchedAt = new Date().toISOString()
    const recordsFetched = getRecordsFetched(value)
    tableNames.forEach((tableName) => {
      updateWorkspaceDataHydrationProgress(workspaceId, source, tableName, recordsFetched, operationId)
      recordWorkspaceDataFetch(workspaceId, source, fetchedAt, tableName)
      completeWorkspaceDataHydration(workspaceId, source, tableName, fetchedAt, operationId)
    })
    return value
  } catch (error) {
    tableNames.forEach((tableName) => {
      if (signal.aborted) {
        cancelWorkspaceDataHydration(workspaceId, source, tableName, operationId)
      } else {
        failWorkspaceDataHydration(workspaceId, source, tableName, undefined, operationId)
      }
    })
    throw error
  }
}

export async function fetchWorkspacePaymentOverview(
  workspaceId: string,
  signal: AbortSignal,
): Promise<WorkspacePaymentOverview> {
  const operationId = createOperationId()
  const [paymentSummary, paygSummary, usageStatus] = await Promise.all([
    readWithFreshness({
      workspaceId,
      signal,
      operationId: `${operationId}:payments`,
      tableNames: WORKSPACE_PAYMENT_FRESHNESS_TABLES.slice(0, 2),
      read: async () => {
        const summary = await getWorkspacePaymentSummary(signal)
        if (summary.workspaceId && summary.workspaceId !== workspaceId) {
          throw new Error('Workspace billing details changed while they were loading')
        }
        return summary
      },
      getRecordsFetched: (summary) => summary.transactions.length + Number(Boolean(summary.configuration)),
    }),
    readWithFreshness({
      workspaceId,
      signal,
      operationId: `${operationId}:payg`,
      tableNames: WORKSPACE_PAYMENT_FRESHNESS_TABLES.slice(2, 4),
      read: () => getWorkspacePaygSummary(signal),
      getRecordsFetched: (summary) => summary.history.length + summary.paymentHistory.length,
    }),
    readWithFreshness({
      workspaceId,
      signal,
      operationId: `${operationId}:usage`,
      tableNames: WORKSPACE_PAYMENT_FRESHNESS_TABLES.slice(4),
      read: () => getWorkspaceUsageStatus(workspaceId, signal),
      getRecordsFetched: (status) => Number(Boolean(status)),
    }),
  ])

  let usageHistory: WorkspaceUsageLocalHistory | null = null
  if (usageStatus) {
    try {
      usageHistory = await saveWorkspaceUsageSnapshot(usageStatus)
    } catch (error) {
      console.warn('[WorkspacePayment] Failed to save local usage history:', error)
    }
  }

  return { paymentSummary, paygSummary, usageStatus, usageHistory }
}

export function useWorkspacePaymentOverview(scope: WorkspacePaymentOverviewScope) {
  const queryClient = useQueryClient()
  const enabled = Boolean(scope.workspaceId && scope.userId && scope.role === 'admin')
  const query = useQuery({
    queryKey: queryKeys.workspacePayment.overview(scope),
    queryFn: ({ signal }) => fetchWorkspacePaymentOverview(scope.workspaceId, signal),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
  })

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const refreshAfterPayment = () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspacePayment.all(scope.workspaceId),
      })
    }
    window.addEventListener(WORKSPACE_PAYMENT_UPDATED_EVENT, refreshAfterPayment)
    return () => window.removeEventListener(WORKSPACE_PAYMENT_UPDATED_EVENT, refreshAfterPayment)
  }, [enabled, queryClient, scope.workspaceId])

  return query
}
