import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/auth/supabase'
import { queryKeys } from '@/query/queryKeys'
import { parseShipmentQr } from '@/postal/domain'
import { tracked, type PostalScope } from './postal'

export const postalQrTables = ['postal_qr_batches', 'postal_generated_qrs'] as const
export interface PostalQrBatch {
  id: string
  workspace_id: string
  organization_id: string | null
  organization_name: string | null
  active: boolean
  quantity: number
  claimed_count: number
  created_by: string
  created_at: string
  updated_at: string
}
export interface PostalGeneratedQr {
  id: string
  workspace_id: string
  batch_id: string
  created_at: string
  claimed_at: string | null
  claimed_by: string | null
  claimant_name: string | null
  organization_name: string | null
  claimed_organization_id: string | null
  shipment_id: string | null
  shipment_number: number | null
  shipment_created_at: string | null
}
export interface PostalQrPageInput extends PostalScope {
  batchId?: string
  page: number
  pageSize: number
  start?: string
  end?: string
  status?: 'all' | 'claimed' | 'unclaimed'
}
const invalid = () => new Error('postal_invalid_result')
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export function normalizeQrBatch(value: unknown, workspaceId: string): PostalQrBatch {
  const row = value as PostalQrBatch
  if (!row || !uuid(row.id) || row.workspace_id !== workspaceId || typeof row.active !== 'boolean'
    || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 10000
    || !Number.isSafeInteger(row.claimed_count) || row.claimed_count < 0 || row.claimed_count > row.quantity
    || !uuid(row.created_by) || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at))
    || (row.organization_id !== null && (!uuid(row.organization_id) || typeof row.organization_name !== 'string')))
    throw invalid()
  return row
}
export function normalizeGeneratedQr(value: unknown, workspaceId: string, batchId: string): PostalGeneratedQr {
  const row = value as PostalGeneratedQr
  if (!row || !uuid(row.id) || row.workspace_id !== workspaceId || row.batch_id !== batchId
    || !Number.isFinite(Date.parse(row.created_at))) throw invalid()
  if (row.claimed_at !== null) {
    if (!Number.isFinite(Date.parse(row.claimed_at)) || !uuid(row.claimed_by) || !uuid(row.shipment_id)
      || !uuid(row.claimed_organization_id) || !Number.isSafeInteger(row.shipment_number) || Number(row.shipment_number) < 1
      || !Number.isFinite(Date.parse(row.shipment_created_at ?? '')) || typeof row.organization_name !== 'string'
      || typeof row.claimant_name !== 'string') throw invalid()
  } else if ([row.claimed_by, row.shipment_id, row.shipment_number, row.claimed_organization_id,
    row.organization_name, row.claimant_name, row.shipment_created_at].some((field) => field !== null)) throw invalid()
  return row
}
export function usePostalQrBatches(input: PostalQrPageInput) {
  return useQuery({
    queryKey: queryKeys.postal.qrBatchPage(input),
    enabled: input.role === 'admin' && !!input.workspaceId,
    queryFn: ({ signal }) => tracked(input, [...postalQrTables, 'postal_organizations'], signal, async () => {
      let request = supabase.from('postal_qr_batch_summaries').select('*', { count: 'exact' })
        .eq('workspace_id', input.workspaceId)
      if (input.start) request = request.gte('created_at', input.start)
      if (input.end) request = request.lt('created_at', input.end)
      const { data, count, error } = await request.order('created_at', { ascending: false }).order('id', { ascending: false })
        .range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1).abortSignal(signal)
      if (error) throw error
      if (!Array.isArray(data) || !Number.isSafeInteger(count) || Number(count) < 0) throw invalid()
      return { data: { rows: data.map((row) => normalizeQrBatch(row, input.workspaceId)), total: count! }, error: null }
    }, (data) => data.rows.length),
  })
}
export function usePostalQrBatch(scope: PostalScope, batchId: string) {
  return useQuery({
    queryKey: queryKeys.postal.qrBatch(scope, batchId),
    enabled: scope.role === 'admin' && !!scope.workspaceId && !!batchId,
    queryFn: ({ signal }) => tracked(scope, [...postalQrTables, 'postal_organizations'], signal, async () => {
      if (!uuid(batchId)) throw invalid()
      const { data, error } = await supabase.from('postal_qr_batch_summaries').select('*')
        .eq('workspace_id', scope.workspaceId).eq('id', batchId).abortSignal(signal).single()
      if (error) throw error
      return { data: normalizeQrBatch(data, scope.workspaceId), error: null }
    }, () => 1),
  })
}
export function usePostalGeneratedQrs(input: PostalQrPageInput) {
  return useQuery({
    queryKey: queryKeys.postal.generatedQrPage(input),
    enabled: input.role === 'admin' && !!input.workspaceId && uuid(input.batchId),
    queryFn: ({ signal }) => tracked(input, 'postal_generated_qrs', signal, async () => {
      let request = supabase.from('postal_generated_qrs').select('*', { count: 'exact' })
        .eq('workspace_id', input.workspaceId).eq('batch_id', input.batchId!)
      if (input.status === 'claimed') request = request.not('claimed_at', 'is', null)
      if (input.status === 'unclaimed') request = request.is('claimed_at', null)
      const { data, count, error } = await request.order('id')
        .range((input.page - 1) * input.pageSize, input.page * input.pageSize - 1).abortSignal(signal)
      if (error) throw error
      if (!Array.isArray(data) || !Number.isSafeInteger(count) || Number(count) < 0) throw invalid()
      return { data: { rows: data.map((row) => normalizeGeneratedQr(row, input.workspaceId, input.batchId!)), total: count! }, error: null }
    }, (data) => data.rows.length),
  })
}

/** Fetch a whole QR batch in bounded pages for the explicit bulk-label print flow. */
export async function fetchPostalGeneratedQrsForBatch(
  scope: PostalScope,
  batchId: string,
  signal: AbortSignal,
) {
  if (scope.role !== 'admin' || !uuid(batchId)) throw invalid()

  return tracked(scope, 'postal_generated_qrs', signal, async () => {
    const pageSize = 1000
    const { data: firstPage, count, error: firstError } = await supabase
      .from('postal_generated_qrs')
      .select('*', { count: 'exact' })
      .eq('workspace_id', scope.workspaceId)
      .eq('batch_id', batchId)
      .order('id')
      .range(0, pageSize - 1)
      .abortSignal(signal)
    if (firstError) throw firstError
    if (!Array.isArray(firstPage) || !Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 10000) throw invalid()

    const rows = firstPage.map((row) => normalizeGeneratedQr(row, scope.workspaceId, batchId))
    for (let offset = pageSize; offset < Number(count); offset += pageSize) {
      const { data, error } = await supabase
        .from('postal_generated_qrs')
        .select('*')
        .eq('workspace_id', scope.workspaceId)
        .eq('batch_id', batchId)
        .order('id')
        .range(offset, Math.min(offset + pageSize - 1, Number(count) - 1))
        .abortSignal(signal)
      if (error) throw error
      if (!Array.isArray(data)) throw invalid()
      rows.push(...data.map((row) => normalizeGeneratedQr(row, scope.workspaceId, batchId)))
    }
    if (rows.length !== Number(count)) throw invalid()
    return { data: { rows, total: Number(count) }, error: null }
  }, (data) => data.rows.length)
}

export async function validateGeneratedPostalQr(scope: PostalScope, raw: string): Promise<string> {
  const id = parseShipmentQr(raw)
  if (!id) throw new Error('postal_qr_unknown')
  const { data, error } = await supabase.rpc('postal_validate_generated_qr', { p_workspace_id: scope.workspaceId, p_qr_id: id })
  if (error) throw error
  if (!data || data.id !== id || data.workspace_id !== scope.workspaceId || !uuid(data.batch_id)) throw invalid()
  return id
}
export function postalQrErrorKey(error: unknown) {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  return Object.entries({
    postal_qr_already_claimed: 'alreadyClaimed', postal_qr_inactive: 'inactive',
    postal_qr_organization_restricted: 'restricted', postal_qr_not_authorized: 'notAuthorized',
    postal_qr_unknown: 'unknown', postal_qr_batch_has_claims: 'hasClaims', postal_qr_invalid_quantity: 'quantity',
  }).find(([code]) => message.includes(code))?.[1]
}
