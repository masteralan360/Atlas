import { useQuery } from '@tanstack/react-query'

import { supabase } from '@/auth/supabase'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { queryKeys } from '@/query/queryKeys'
import {
  cancelWorkspaceDataHydration,
  completeWorkspaceDataHydration,
  failWorkspaceDataHydration,
  recordWorkspaceDataFetch,
  startWorkspaceDataHydration,
  updateWorkspaceDataHydrationProgress,
} from '@/workspace/workspaceDataFreshness'

export const TIERED_COMMISSION_FRESHNESS_TABLES = [
  'tiered_commission_programs',
  'tiered_commission_tiers',
  'tiered_commission_assignments',
  'tiered_commission_product_rates',
  'tiered_commission_cycles',
  'tiered_commission_agent_months',
  'tiered_commission_sales',
  'tiered_commission_entries',
  'tiered_commission_audit',
] as const

export type TieredCommissionTier = {
  id: string
  name: string
  position: number
  minimumSales: number
  maximumSales: number | null
}

export type TieredCommissionProgram = {
  id: string
  name: string
  description: string | null
  isActive: boolean
  tiers: TieredCommissionTier[]
  agentIds?: string[]
}

export type TieredCommissionCycle = {
  id: string
  monthStart: string
  timeZone: string
  status: 'active' | 'settled'
  activatedAt?: string
  settledAt?: string | null
}

export type TieredCommissionAgent = {
  id: string
  name: string
  programId: string
  programName: string
  qualifyingSales: number
  currentTierId: string | null
  currentTierName: string | null
  nextTierName: string | null
  salesToNextTier: number | null
  commissionTotalIqd: number
  assignmentId: string | null
}

export type TieredCommissionEntry = {
  id: string
  agentId: string
  salesOrderId: string
  productId: string
  productName: string
  productSku: string | null
  programName: string
  tierName: string
  quantity: number
  amountIqd: number
  kind: 'accrual' | 'reversal' | 'reinstatement'
  status: 'earned' | 'settled' | 'correction_pending'
  occurredAt: string
  orderItemId: string
  relatedEntryId: string | null
}

export type TieredCommissionDashboard = {
  cycle: TieredCommissionCycle | null
  cycles: TieredCommissionCycle[]
  programs: TieredCommissionProgram[]
  agents: TieredCommissionAgent[]
  eligibleAgents: Array<{ id: string; name: string; isEligible: boolean }>
  entries: TieredCommissionEntry[]
  entryCount: number
  entryPage: number
  entryPageSize: number
  pendingSales: number
  audit: Array<{ eventType: string; details: Record<string, unknown>; createdAt: string }>
}

export type TieredProductCommissionConfiguration = {
  programs: Array<{
    id: string
    name: string
    isActive: boolean
    tiers: TieredCommissionTier[]
  }>
  rates: Array<{ programId: string; tierId: string; amountIqd: number }>
}

export type TieredProductCommissionRateDraft = {
  programId: string
  tierId: string
  amountIqd: string
}

const dashboardKey = (input: {
  workspaceId: string
  monthStart: string | null
  page: number
  pageSize: number
  userId: string
}) => queryKeys.tieredPerformanceCommissions.dashboard(input)

async function requestRemote<T>(
  workspaceId: string,
  rpcName: string,
  args: Record<string, unknown>,
  tableNames: readonly string[],
  signal?: AbortSignal,
): Promise<T> {
  const operationId = crypto.randomUUID()
  for (const tableName of tableNames) {
    startWorkspaceDataHydration(workspaceId, 'supabase', tableName, operationId)
  }
  try {
    const request = supabase.rpc(rpcName, args)
    const result = await runSupabaseAction(`tieredCommission.${rpcName}`, () => (
      signal ? request.abortSignal(signal) : request
    ), { signal })
    if (result.error) throw result.error
    signal?.throwIfAborted()
    const data = result.data as T
    for (const tableName of tableNames) {
      updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', tableName, 1, operationId)
      recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, tableName)
      completeWorkspaceDataHydration(workspaceId, 'supabase', tableName, undefined, operationId)
    }
    return data
  } catch (error) {
    for (const tableName of tableNames) {
      if (signal?.aborted) cancelWorkspaceDataHydration(workspaceId, 'supabase', tableName, operationId)
      else failWorkspaceDataHydration(workspaceId, 'supabase', tableName, undefined, operationId)
    }
    throw error
  }
}

export function fetchTieredCommissionDashboard(input: {
  workspaceId: string
  monthStart?: string | null
  page?: number
  pageSize?: number
  signal?: AbortSignal
}) {
  return requestRemote<TieredCommissionDashboard>(input.workspaceId, 'get_tiered_commission_dashboard', {
    p_workspace_id: input.workspaceId,
    p_month_start: input.monthStart || null,
    p_page: input.page ?? 1,
    p_page_size: input.pageSize ?? 20,
  }, TIERED_COMMISSION_FRESHNESS_TABLES, input.signal)
}

export function useTieredCommissionDashboard(input: {
  workspaceId?: string
  monthStart?: string | null
  page: number
  pageSize: number
  userId?: string
  enabled: boolean
}) {
  return useQuery({
    queryKey: dashboardKey({
      workspaceId: input.workspaceId ?? '',
      monthStart: input.monthStart ?? null,
      page: input.page,
      pageSize: input.pageSize,
      userId: input.userId ?? '',
    }),
    queryFn: ({ signal }) => fetchTieredCommissionDashboard({
      workspaceId: input.workspaceId!,
      monthStart: input.monthStart,
      page: input.page,
      pageSize: input.pageSize,
      signal,
    }),
    enabled: input.enabled && Boolean(input.workspaceId),
    refetchInterval: (query) => query.state.data?.cycle?.status === 'active' ? 15_000 : false,
    refetchIntervalInBackground: false,
  })
}

export async function saveTieredCommissionProgram(workspaceId: string, payload: {
  id?: string
  name: string
  description: string
  isActive: boolean
  tiers: Array<{ id?: string; name: string; position: number; minimumSales: number }>
  agentIds: string[]
}) {
  const { data, error } = await runSupabaseAction('tieredCommission.program.save', () => supabase.rpc(
    'save_tiered_commission_program',
    { p_workspace_id: workspaceId, p_payload: payload },
  ))
  if (error) throw error
  return data as string
}

export async function settleAndActivateTieredCommissionMonth(workspaceId: string, expectedCycleId: string) {
  const { data, error } = await runSupabaseAction('tieredCommission.month.settle', () => supabase.rpc(
    'settle_and_activate_tiered_commission_month',
    { p_workspace_id: workspaceId, p_expected_cycle_id: expectedCycleId },
  ))
  if (error) throw error
  return data as { activeMonthStart: string; deferredSalesProcessed: number }
}

export async function fetchTieredProductCommissionConfiguration(input: {
  workspaceId: string
  productId?: string
  signal?: AbortSignal
}) {
  return requestRemote<TieredProductCommissionConfiguration>(input.workspaceId,
    'get_tiered_commission_product_configuration', {
      p_workspace_id: input.workspaceId,
      p_product_id: input.productId ?? null,
    }, ['tiered_commission_programs', 'tiered_commission_tiers', 'tiered_commission_product_rates'], input.signal)
}

export function useTieredProductCommissionConfiguration(input: {
  workspaceId?: string
  productId?: string
  userId?: string
  enabled: boolean
}) {
  return useQuery({
    queryKey: queryKeys.tieredPerformanceCommissions.productConfiguration(
      input.workspaceId ?? '', input.productId ?? null, input.userId ?? '',
    ),
    queryFn: ({ signal }) => fetchTieredProductCommissionConfiguration({
      workspaceId: input.workspaceId!, productId: input.productId, signal,
    }),
    enabled: input.enabled && Boolean(input.workspaceId),
  })
}

export async function replaceTieredProductCommissionRates(
  workspaceId: string,
  productId: string,
  rates: TieredProductCommissionRateDraft[],
) {
  const { error } = await runSupabaseAction('tieredCommission.productRates.save', () => supabase.rpc(
    'save_tiered_commission_product_rates',
    {
      p_workspace_id: workspaceId,
      p_product_id: productId,
      p_rates: rates.map((rate) => ({
        programId: rate.programId,
        tierId: rate.tierId,
        amountIqd: Number(rate.amountIqd.replace(/,/g, '')),
      })),
    },
  ))
  if (error) throw error
}
