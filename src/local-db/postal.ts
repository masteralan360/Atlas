import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { supabase } from '@/auth/supabase'
import { db } from './database'
import { toCamelCase } from '@/lib/utils'
import type { PaymentTransaction, BusinessPartner } from './models'
import { queryKeys } from '@/query/queryKeys'
import { queryClient } from '@/query/queryClient'
import {
  normalizePostalDashboardSummary,
  sanitizePostalSearch,
} from './postalSummary'
import type { PostalDashboardSummary } from './postalSummary'
import {
  startWorkspaceDataHydration,
  updateWorkspaceDataHydrationProgress,
  completeWorkspaceDataHydration,
  failWorkspaceDataHydration,
  cancelWorkspaceDataHydration,
  recordWorkspaceDataFetch,
} from '@/workspace/workspaceDataFreshness'
import {
  parseShipmentQr,
  parsePostalShipmentId,
  postalStates,
  type PostalShipment,
  type PostalRole,
  type PostalEvent,
  type PostalTransfer,
  type PostalCodRecord,
} from '@/postal/domain'

export const postalTables = {
  shipments: 'postal_shipments',
  branches: 'postal_branches',
  organizations: 'postal_organizations',
  cod: 'postal_cod_records',
} as const
export const postalSummaryTables = [
  'postal_shipments',
  'postal_cod_records',
] as const
export interface PostalScope {
  workspaceId: string
  userId: string
  role: PostalRole
  permissionScope: string
}
export interface PostalPageInput extends PostalScope {
  kind: keyof typeof postalTables
  page: number
  pageSize: number
  search: string
  status?: string
  start?: string
  end?: string
}
export interface PostalPage<T> {
  rows: T[]
  total: number
}
export interface PostalSummaryInput extends PostalScope {
  search: string
  status?: string
  start?: string
  end?: string
}

async function tracked<T>(
  scope: PostalScope,
  table: string | readonly string[],
  signal: AbortSignal | undefined,
  read: () => PromiseLike<{ data: T | null; error: unknown }>,
  count: (data: T, table: string) => number,
): Promise<T> {
  const op = crypto.randomUUID()
  const tables = typeof table === 'string' ? [table] : table
  const cacheTable = tables[0]
  for (const name of tables)
    startWorkspaceDataHydration(scope.workspaceId, 'supabase', name, op)
  try {
    const { data, error } = await read()
    if (error) throw error
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (data === null) throw new Error('postal_unavailable')
    for (const name of tables)
      updateWorkspaceDataHydrationProgress(
        scope.workspaceId,
        'supabase',
        name,
        count(data, name),
        op,
      )
    // Cache canonical server rows, rather than duplicating a snapshot on every
    // refetch. There are no offline/optimistic rows in this transaction-only cache.
    const body = data as Record<string, unknown>
    const rows: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(body.rows)
        ? body.rows
        : [data]
    const snapshots = rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const record = row as Record<string, unknown>
      const id =
        typeof record.id === 'string'
          ? record.id
          : typeof record.user_id === 'string'
            ? record.user_id
            : null
      if (!id) return []
      return [
        {
          id: `${scope.workspaceId}:${scope.userId}:${scope.role}:${scope.permissionScope}:${cacheTable}:${id}`,
          workspaceId: scope.workspaceId,
          viewerId: scope.userId,
          table: cacheTable,
          fetchedAt: Date.now(),
          data: record,
        },
      ]
    })
    if (snapshots.length) await db.table('postal_cache').bulkPut(snapshots)
    const stale = await db
      .table('postal_cache')
      .where('fetchedAt')
      .below(Date.now() - 86400000)
      .limit(200)
      .primaryKeys()
    if (stale.length) await db.table('postal_cache').bulkDelete(stale)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    for (const name of tables) {
      recordWorkspaceDataFetch(scope.workspaceId, 'supabase', undefined, name)
      completeWorkspaceDataHydration(
        scope.workspaceId,
        'supabase',
        name,
        undefined,
        op,
      )
    }
    return data
  } catch (error) {
    for (const name of tables) {
      if (signal?.aborted)
        cancelWorkspaceDataHydration(scope.workspaceId, 'supabase', name, op)
      else
        failWorkspaceDataHydration(
          scope.workspaceId,
          'supabase',
          name,
          undefined,
          op,
        )
    }
    throw error
  }
}
function normalizeShipment(row: PostalShipment): PostalShipment {
  if (
    !row.id ||
    !row.qr_id ||
    !Number.isSafeInteger(Number(row.shipment_number)) ||
    Number(row.shipment_number) <= 0 ||
    !postalStates.includes(row.state) ||
    !Number.isSafeInteger(Number(row.cod_amount))
  )
    throw new Error('postal_invalid_result')
  return {
    ...row,
    shipment_number: Number(row.shipment_number),
    cod_amount: Number(row.cod_amount),
  }
}
export function usePostalPage<T>(input: PostalPageInput, enabled = true) {
  return useQuery({
    queryKey: queryKeys.postal.page(input),
    enabled: enabled && !!input.workspaceId,
    queryFn: async ({ signal }): Promise<PostalPage<T>> => {
      const table = postalTables[input.kind]
      const trackedTables =
        input.kind === 'cod' ? [table, 'postal_shipments'] : table
      return tracked(
        input,
        trackedTables,
        signal,
        async () => {
          let query = supabase
            .from(table)
            .select('*', { count: 'exact' })
            .eq('workspace_id', input.workspaceId)
          if (input.kind === 'shipments') {
            query = query.is('deleted_at', null)
            if (input.status && input.status !== 'all')
              query = query.eq('state', input.status)
          }
          const search = sanitizePostalSearch(input.search)
          if (search) {
            if (input.kind === 'shipments') {
              const shipmentId = parsePostalShipmentId(search)
              if (shipmentId) {
                const yearStart = `${String(shipmentId.year).padStart(4, '0')}-01-01T00:00:00.000Z`
                const nextYearStart = `${String(shipmentId.year + 1).padStart(4, '0')}-01-01T00:00:00.000Z`
                query = query
                  .eq('shipment_number', shipmentId.shipmentNumber)
                  .gte('created_at', yearStart)
                  .lt('created_at', nextYearStart)
              } else {
                const predicates = [
                  `recipient_name.ilike.%${search}%`,
                  `primary_phone.ilike.%${search}%`,
                ]
                if (/^\d+$/.test(search))
                  predicates.push(`shipment_number.eq.${search}`)
                query = query.or(predicates.join(','))
              }
            }
            else if (
              input.kind === 'branches' ||
              input.kind === 'organizations'
            )
              query = query.ilike('name', `%${search}%`)
          }
          if (input.start) query = query.gte('created_at', input.start)
          if (input.end) query = query.lt('created_at', input.end)
          query =
            input.kind === 'branches' || input.kind === 'organizations'
              ? query.order('name').order('id')
              : query
                  .order('created_at', { ascending: false })
                  .order('id', { ascending: false })
          const { data, count, error } = await query
            .range(
              (input.page - 1) * input.pageSize,
              input.page * input.pageSize - 1,
            )
            .abortSignal(signal)
          if (error) return { data: null, error }
          let rows: unknown[] = data ?? []
          if (input.kind === 'cod' && rows.length > 0) {
            const codRows = rows as Array<Record<string, unknown>>
            const shipmentIds = Array.from(
              new Set(
                codRows
                  .map((row) => row.shipment_id)
                  .filter((id): id is string => typeof id === 'string'),
              ),
            )
            if (shipmentIds.length > 0) {
              const { data: shipments, error: shipmentsError } = await supabase
                .from('postal_shipments')
                .select('id,shipment_number,created_at')
                .eq('workspace_id', input.workspaceId)
                .in('id', shipmentIds)
                .abortSignal(signal)
              if (shipmentsError) return { data: null, error: shipmentsError }
              const shipmentsById = new Map<
                string,
                { shipment_number: number; created_at: string }
              >()
              for (const shipment of shipments ?? []) {
                const number = Number(shipment.shipment_number)
                if (
                  !Number.isSafeInteger(number) ||
                  number <= 0 ||
                  typeof shipment.created_at !== 'string'
                )
                  throw new Error('postal_invalid_result')
                shipmentsById.set(shipment.id, {
                  shipment_number: number,
                  created_at: shipment.created_at,
                })
              }
              rows = codRows.map((row) => {
                const shipmentId = row.shipment_id
                const shipment =
                  typeof shipmentId === 'string'
                    ? shipmentsById.get(shipmentId)
                    : undefined
                return {
                  ...row,
                  postal_shipments: shipment ?? null,
                }
              })
            }
          }
          const normalizedRows =
            input.kind === 'shipments'
              ? rows.map((row) =>
                  normalizeShipment(row as PostalShipment),
                )
              : rows
          return {
            data: { rows: normalizedRows as T[], total: count ?? 0 },
            error: null,
          }
        },
        (result) => result.rows.length,
      )
    },
  })
}
export function usePostalSummary(input: PostalSummaryInput, enabled = true) {
  return useQuery({
    queryKey: queryKeys.postal.summary(input),
    enabled: enabled && !!input.workspaceId && !!input.userId,
    queryFn: ({ signal }): Promise<PostalDashboardSummary> =>
      tracked(
        input,
        postalSummaryTables,
        signal,
        async () => {
          const { data, error } = await supabase
            .rpc('postal_dashboard_summary', {
              p_workspace_id: input.workspaceId,
              p_search: sanitizePostalSearch(input.search),
              p_status: input.status ?? 'all',
              p_start: input.start ?? null,
              p_end: input.end ?? null,
            })
            .abortSignal(signal)
          if (error) throw error
          return { data: normalizePostalDashboardSummary(data), error: null }
        },
        (summary, table) =>
          table === 'postal_cod_records'
            ? summary.collection_records
            : summary.total_shipments,
      ),
  })
}
export function usePostalDetail(scope: PostalScope, shipmentId: string) {
  return useQuery({
    queryKey: queryKeys.postal.detail(scope, shipmentId),
    enabled: !!shipmentId && !!scope.workspaceId,
    queryFn: async ({ signal }) => {
      const parsedId = parsePostalShipmentId(shipmentId)
      if (!parsedId) throw new Error('postal_unavailable')
      const yearStart = `${String(parsedId.year).padStart(4, '0')}-01-01T00:00:00.000Z`
      const nextYearStart = `${String(parsedId.year + 1).padStart(4, '0')}-01-01T00:00:00.000Z`
      const shipment = await tracked<PostalShipment>(
        scope,
        'postal_shipments',
        signal,
        () =>
          supabase
            .from('postal_shipments')
            .select('*')
            .eq('workspace_id', scope.workspaceId)
            .eq('shipment_number', parsedId.shipmentNumber)
            .gte('created_at', yearStart)
            .lt('created_at', nextYearStart)
            .is('deleted_at', null)
            .abortSignal(signal)
            .single(),
        () => 1,
      )
      const [transfers, summary] = await Promise.all([
        tracked<PostalTransfer[]>(
          scope,
          'postal_transfers',
          signal,
          () =>
            supabase
              .from('postal_transfers')
              .select('*')
              .eq('workspace_id', scope.workspaceId)
              .eq('shipment_id', shipment.id)
              .in('status', ['authorized', 'dispatched'])
              .abortSignal(signal),
          (x) => x.length,
        ),
        tracked<{ collected: number; settled: number; record_count: number }>(
          scope,
          'postal_cod_records',
          signal,
          () =>
            supabase
            .rpc('postal_financial_summary', { p_shipment_id: shipment.id })
              .abortSignal(signal),
          () => 1,
        ),
      ])
      return {
        shipment: normalizeShipment(shipment as PostalShipment),
        transfer: transfers[0],
        summary: {
          collected: Number(summary.collected),
          settled: Number(summary.settled),
        },
      }
    },
  })
}
export function usePostalCodHistory(scope: PostalScope, id: string) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.postal.detail(scope, id), 'cod-history'],
    enabled: !!id,
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      tracked<PostalCodRecord[]>(
        scope,
        'postal_cod_records',
        signal,
        () =>
          supabase
            .from('postal_cod_records')
            .select('*')
            .eq('workspace_id', scope.workspaceId)
            .eq('shipment_id', id)
            .order('created_at')
            .order('id')
            .range(pageParam, pageParam + 99)
            .abortSignal(signal),
        (x) => x.length,
      ),
    getNextPageParam: (last, pages) =>
      last.length === 100 ? pages.length * 100 : undefined,
  })
}
export function usePostalEvents(scope: PostalScope, id: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.postal.events(scope, id),
    enabled: !!id,
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      tracked<PostalEvent[]>(
        scope,
        'postal_events',
        signal,
        () =>
          supabase
            .from('postal_events')
            .select('*')
            .eq('workspace_id', scope.workspaceId)
            .eq('shipment_id', id)
            .gt('sequence', pageParam)
            .order('sequence')
            .limit(100)
            .abortSignal(signal),
        (x) => x.length,
      ),
    getNextPageParam: (last) =>
      last.length === 100 ? last[last.length - 1].sequence : undefined,
  })
}
export function usePostalMembers(scope: PostalScope, organizationId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.postal.members(scope, organizationId),
    enabled: !!organizationId && scope.role === 'admin',
    initialPageParam: '',
    queryFn: ({ signal, pageParam }) =>
      tracked<
        Array<{
          user_id: string
          organization_id: string
          profiles: { name: string } | null
        }>
      >(
        scope,
        'postal_memberships',
        signal,
        () => {
          let q = supabase
            .from('postal_memberships')
            .select(
              'user_id,organization_id,profiles!postal_memberships_user_id_fkey(name)',
            )
            .eq('workspace_id', scope.workspaceId)
            .eq('organization_id', organizationId)
            .order('user_id')
            .limit(50)
          if (pageParam) q = q.gt('user_id', pageParam)
          return q.abortSignal(signal).returns<
            Array<{
              user_id: string
              organization_id: string
              profiles: { name: string } | null
            }>
          >()
        },
        (x) => x.length,
      ),
    getNextPageParam: (last) =>
      last.length === 50 ? last[last.length - 1].user_id : undefined,
  })
}
export async function resolvePostalQr(scope: PostalScope, raw: string) {
  const qr = parseShipmentQr(raw)
  if (!qr) throw new Error('postal_invalid_qr')
  const data = await tracked<PostalShipment>(
    scope,
    'postal_shipments',
    undefined,
    () =>
      supabase
        .from('postal_shipments')
        .select('*')
        .eq('workspace_id', scope.workspaceId)
        .eq('qr_id', qr)
        .is('deleted_at', null)
        .single(),
    () => 1,
  )
  return normalizeShipment(data)
}
export async function searchPostalDrivers(
  scope: PostalScope,
  search: string,
): Promise<BusinessPartner[]> {
  const { data, error } = await supabase
    .schema('crm')
    .from('agents')
    .select('id,business_partners!inner(*)')
    .eq('workspace_id', scope.workspaceId)
    .eq('agent_type', 'driver')
    .eq('status', 'active')
    .eq('is_deleted', false)
    .eq('business_partners.is_deleted', false)
    .ilike(
      'business_partners.partner_name',
      `%${search.trim().replace(/[%_]/g, '')}%`,
    )
    .order('id')
    .limit(20)
    .returns<
      Array<{ id: string; business_partners: Record<string, unknown> }>
    >()
  if (error) throw error
  return (data ?? []).map(
    (row) =>
      ({
        ...toCamelCase(row.business_partners),
        agentFacetId: row.id,
        syncStatus: 'synced',
      }) as unknown as BusinessPartner,
  )
}
export async function postalCommand<T>(
  scope: PostalScope,
  command: string,
  payload: object,
  requestId: string,
): Promise<T> {
  const { data, error } = await supabase.rpc('postal_command', {
    p_command: command,
    p_payload: { ...payload, workspace_id: scope.workspaceId },
    p_request_id: requestId,
  })
  if (error) throw error
  if (data?.payment_transaction) {
    try {
      await db.payment_transactions.put({
        ...toCamelCase(data.payment_transaction),
        syncStatus: 'synced',
        lastSyncedAt: new Date().toISOString(),
      } as unknown as PaymentTransaction)
    } catch (cacheError) {
      console.warn(
        '[Postal] Payment committed; local cache refresh failed',
        cacheError,
      )
    }
  }
  await queryClient.invalidateQueries({
    queryKey: queryKeys.postal.all(scope.workspaceId),
  })
  if (command === 'collection' || command === 'settlement') {
    window.dispatchEvent(new CustomEvent('payment-transactions:changed'))
  }
  return data as T
}
