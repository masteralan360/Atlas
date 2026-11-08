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

export const COACH_DATA_FRESHNESS_TABLES = [
  'commerce_operations_records',
  'agents',
  'business_partners',
  'workspace_permissions',
  'tiered_commission_cycles',
  'tiered_commission_assignments',
  'tiered_commission_programs',
  'tiered_commission_tiers',
  'tiered_commission_agent_months',
  'tiered_commission_entries',
] as const

export const COACH_DATA_PAGE_FRESHNESS_TABLES = [
  ...COACH_DATA_FRESHNESS_TABLES,
  'sales_orders',
] as const

export type CoachDirectoryEntry = {
  userId: string
  name: string
}

export type CoachDirectorySnapshot = {
  coaches: CoachDirectoryEntry[]
}

export type CoachDataSnapshot = {
  coach: {
    name: string
    phone: string | null
    city: string | null
  } | null
  tier: {
    cycleMonthStart: string
    timeZone: string
    programName: string | null
    currentTierName: string | null
    qualifyingSales: number
    nextTierName: string | null
    salesToNextTier: number | null
    commissionTotalIqd: number
  } | null
}

export type CoachRecentIntakeOrder = {
  id: string
  orderNumber: string
  customerName: string | null
  status: string
  isPaid: boolean
  total: number
  currency: string
  createdAt: string | null
}

export type CoachRecentIntakeSnapshot = {
  items: CoachRecentIntakeOrder[]
  totalCount: number
  unpaidCount: number
  totalsByCurrency: Array<{ currency: string; total: number }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid coach data field: ${field}`)
  return parsed
}

function normalizeCoachData(value: unknown): CoachDataSnapshot {
  if (!isRecord(value)) throw new Error('Invalid coach data response')

  let coach: CoachDataSnapshot['coach'] = null
  if (value.coach != null) {
    if (!isRecord(value.coach) || typeof value.coach.name !== 'string') {
      throw new Error('Invalid coach profile response')
    }
    coach = {
      name: value.coach.name,
      phone: optionalString(value.coach.phone),
      city: optionalString(value.coach.city),
    }
  }

  let tier: CoachDataSnapshot['tier'] = null
  if (value.tier != null) {
    if (!isRecord(value.tier) || typeof value.tier.cycleMonthStart !== 'string') {
      throw new Error('Invalid coach tier response')
    }
    tier = {
      cycleMonthStart: value.tier.cycleMonthStart,
      timeZone: optionalString(value.tier.timeZone) ?? 'Asia/Baghdad',
      programName: optionalString(value.tier.programName),
      currentTierName: optionalString(value.tier.currentTierName),
      qualifyingSales: requiredNumber(value.tier.qualifyingSales, 'qualifyingSales'),
      nextTierName: optionalString(value.tier.nextTierName),
      salesToNextTier: value.tier.salesToNextTier == null
        ? null
        : requiredNumber(value.tier.salesToNextTier, 'salesToNextTier'),
      commissionTotalIqd: requiredNumber(value.tier.commissionTotalIqd, 'commissionTotalIqd'),
    }
  }

  return { coach, tier }
}

function normalizeCoachDirectory(value: unknown): CoachDirectorySnapshot {
  if (!isRecord(value) || !Array.isArray(value.coaches)) {
    throw new Error('Invalid coach directory response')
  }

  const coaches = value.coaches.map((coach) => {
    if (!isRecord(coach) || typeof coach.userId !== 'string' || typeof coach.name !== 'string') {
      throw new Error('Invalid coach directory entry')
    }
    return { userId: coach.userId, name: coach.name }
  })

  return { coaches }
}

function normalizeCoachRecentIntake(value: unknown): CoachRecentIntakeSnapshot {
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.totalsByCurrency)) {
    throw new Error('Invalid coach recent intake response')
  }

  const items = value.items.map((item) => {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.orderNumber !== 'string'
      || typeof item.status !== 'string'
      || typeof item.isPaid !== 'boolean'
      || typeof item.currency !== 'string'
    ) {
      throw new Error('Invalid coach sale order')
    }
    return {
      id: item.id,
      orderNumber: item.orderNumber,
      customerName: optionalString(item.customerName),
      status: item.status,
      isPaid: item.isPaid,
      total: requiredNumber(item.total, 'order.total'),
      currency: item.currency,
      createdAt: optionalString(item.createdAt),
    }
  })

  const totalsByCurrency = value.totalsByCurrency.map((total) => {
    if (!isRecord(total) || typeof total.currency !== 'string') {
      throw new Error('Invalid coach intake currency total')
    }
    return { currency: total.currency, total: requiredNumber(total.total, 'totalByCurrency.total') }
  })

  return {
    items,
    totalCount: requiredNumber(value.totalCount, 'totalCount'),
    unpaidCount: requiredNumber(value.unpaidCount, 'unpaidCount'),
    totalsByCurrency,
  }
}

async function requestCoachData<T>(input: {
  workspaceId: string
  rpcName: string
  args: Record<string, unknown>
  operation: string
  signal?: AbortSignal
}, normalize: (value: unknown) => T): Promise<T> {
  const operationId = crypto.randomUUID()
  for (const tableName of COACH_DATA_FRESHNESS_TABLES) {
    startWorkspaceDataHydration(input.workspaceId, 'supabase', tableName, operationId)
  }

  try {
    const request = supabase.rpc(input.rpcName, input.args)
    const result = await runSupabaseAction(input.operation, () => (
      input.signal ? request.abortSignal(input.signal) : request
    ), { signal: input.signal })
    if (result.error) throw result.error
    input.signal?.throwIfAborted()

    const data = normalize(result.data)
    for (const tableName of COACH_DATA_FRESHNESS_TABLES) {
      updateWorkspaceDataHydrationProgress(input.workspaceId, 'supabase', tableName, 1, operationId)
      recordWorkspaceDataFetch(input.workspaceId, 'supabase', undefined, tableName)
      completeWorkspaceDataHydration(input.workspaceId, 'supabase', tableName, undefined, operationId)
    }
    return data
  } catch (error) {
    for (const tableName of COACH_DATA_FRESHNESS_TABLES) {
      if (input.signal?.aborted) cancelWorkspaceDataHydration(input.workspaceId, 'supabase', tableName, operationId)
      else failWorkspaceDataHydration(input.workspaceId, 'supabase', tableName, undefined, operationId)
    }
    throw error
  }
}

export function fetchCoachData(input: {
  workspaceId: string
  coachUserId?: string
  signal?: AbortSignal
}): Promise<CoachDataSnapshot> {
  const isAdminSelection = Boolean(input.coachUserId)
  return requestCoachData({
    workspaceId: input.workspaceId,
    rpcName: isAdminSelection ? 'get_coach_data_for_admin' : 'get_coach_data',
    args: {
      p_workspace_id: input.workspaceId,
      ...(input.coachUserId ? { p_coach_user_id: input.coachUserId } : {}),
    },
    operation: isAdminSelection ? 'coachData.getForAdmin' : 'coachData.getOwn',
    signal: input.signal,
  }, normalizeCoachData)
}

export function fetchCoachDirectory(input: {
  workspaceId: string
  signal?: AbortSignal
}): Promise<CoachDirectorySnapshot> {
  return requestCoachData({
    workspaceId: input.workspaceId,
    rpcName: 'get_coach_data_directory',
    args: { p_workspace_id: input.workspaceId },
    operation: 'coachData.getDirectory',
    signal: input.signal,
  }, normalizeCoachDirectory)
}

export async function fetchCoachRecentIntake(input: {
  workspaceId: string
  coachUserId: string
  page: number
  pageSize: number
  createdFrom?: string
  createdBefore?: string
  signal?: AbortSignal
}): Promise<CoachRecentIntakeSnapshot> {
  const operationId = crypto.randomUUID()
  const freshnessTable = 'sales_orders'
  startWorkspaceDataHydration(input.workspaceId, 'supabase', freshnessTable, operationId)

  try {
    const request = supabase.rpc('get_coach_recent_intake_orders', {
      p_workspace_id: input.workspaceId,
      p_coach_user_id: input.coachUserId,
      p_page: input.page,
      p_page_size: input.pageSize,
      p_created_from: input.createdFrom ?? null,
      p_created_before: input.createdBefore ?? null,
    })
    const result = await runSupabaseAction('coachData.getRecentIntake', () => (
      input.signal ? request.abortSignal(input.signal) : request
    ), { signal: input.signal })
    if (result.error) throw result.error
    input.signal?.throwIfAborted()

    const data = normalizeCoachRecentIntake(result.data)
    updateWorkspaceDataHydrationProgress(input.workspaceId, 'supabase', freshnessTable, 1, operationId)
    recordWorkspaceDataFetch(input.workspaceId, 'supabase', undefined, freshnessTable)
    completeWorkspaceDataHydration(input.workspaceId, 'supabase', freshnessTable, undefined, operationId)
    return data
  } catch (error) {
    if (input.signal?.aborted) cancelWorkspaceDataHydration(input.workspaceId, 'supabase', freshnessTable, operationId)
    else failWorkspaceDataHydration(input.workspaceId, 'supabase', freshnessTable, undefined, operationId)
    throw error
  }
}

export function useCoachData(input: {
  workspaceId?: string
  userId?: string
  coachUserId?: string | null
  enabled: boolean
}) {
  const queryKey = input.coachUserId
    ? queryKeys.coachData.selected(input.workspaceId ?? '', input.userId ?? '', input.coachUserId)
    : queryKeys.coachData.own(input.workspaceId ?? '', input.userId ?? '')

  return useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchCoachData({
      workspaceId: input.workspaceId!,
      coachUserId: input.coachUserId ?? undefined,
      signal,
    }),
    enabled: input.enabled && Boolean(input.workspaceId && input.userId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
}

export function useCoachDirectory(input: {
  workspaceId?: string
  userId?: string
  enabled: boolean
}) {
  return useQuery({
    queryKey: queryKeys.coachData.directory(input.workspaceId ?? '', input.userId ?? ''),
    queryFn: ({ signal }) => fetchCoachDirectory({ workspaceId: input.workspaceId!, signal }),
    enabled: input.enabled && Boolean(input.workspaceId && input.userId),
    refetchIntervalInBackground: false,
  })
}

export function useCoachRecentIntake(input: {
  workspaceId?: string
  viewerId?: string
  coachUserId?: string
  page: number
  pageSize: number
  createdFrom?: string
  createdBefore?: string
  enabled: boolean
}) {
  return useQuery({
    queryKey: queryKeys.orders.coachRecentIntake({
      workspaceId: input.workspaceId ?? '',
      viewerId: input.viewerId ?? '',
      coachUserId: input.coachUserId ?? '',
      page: input.page,
      pageSize: input.pageSize,
      createdFrom: input.createdFrom,
      createdBefore: input.createdBefore,
    }),
    queryFn: ({ signal }) => fetchCoachRecentIntake({
      workspaceId: input.workspaceId!,
      coachUserId: input.coachUserId!,
      page: input.page,
      pageSize: input.pageSize,
      createdFrom: input.createdFrom,
      createdBefore: input.createdBefore,
      signal,
    }),
    enabled: input.enabled && Boolean(input.workspaceId && input.viewerId && input.coachUserId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
}
