import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/auth/supabase'
import { queryKeys } from '@/query/queryKeys'
import { tracked } from './postal'
import {
  canReadPostalStatement,
  normalizePostalOrganization,
  normalizePostalStatement,
  postalStatementDisplayConfig,
  postalStatementTables,
  type PostalStatement,
  type PostalStatementEntry,
  type PostalStatementInput,
} from './postalStatementData'

export type PostalStatementPrintInput = Omit<PostalStatementInput, 'page' | 'pageSize'>

export interface PostalStatementPrintShipment {
  qr_id: string
  governorate: string
  area: string
  address: string | null
  cod_amount: string
  delivery_fee: string | null
  pieces: number | null
}

export interface PostalStatementPrintEntry extends PostalStatementEntry {
  shipment: PostalStatementPrintShipment
}

export interface PostalStatementPrintData extends Omit<PostalStatement, 'entries'> {
  entries: PostalStatementPrintEntry[]
  shipment_counts: { total: number; baghdad: number; provinces: number }
  start?: string
  end?: string
  search: string
  kind: PostalStatementPrintInput['kind']
  generated_at: string
}

export interface PostalStatementPrintPageData extends PostalStatementPrintData {
  pageNumber: number
  pageCount: number
  rowOffset: number
  isFirstPage: boolean
  isLastPage: boolean
}

const PAGE_SIZE = 100
const PAGE_BATCH_SIZE = 4

function normalizeWholeAmount(value: unknown, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null
  const normalized = String(value)
  if (!/^-?\d+$/.test(normalized)) throw new Error('postal_invalid_result')
  return normalized
}

function normalizeShipmentDetails(value: unknown, workspaceId: string, organizationId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('postal_invalid_result')
  const row = value as Record<string, unknown>
  if (row.workspace_id !== workspaceId || row.organization_id !== organizationId
    || typeof row.id !== 'string' || typeof row.qr_id !== 'string'
    || typeof row.governorate !== 'string' || typeof row.area !== 'string'
    || (row.address !== null && typeof row.address !== 'string')) throw new Error('postal_invalid_result')
  const pieces = row.pieces === null || row.pieces === undefined ? null : Number(row.pieces)
  if (pieces !== null && (!Number.isSafeInteger(pieces) || pieces < 0)) throw new Error('postal_invalid_result')
  return {
    id: row.id,
    details: {
      qr_id: row.qr_id,
      governorate: row.governorate,
      area: row.area,
      address: row.address,
      cod_amount: normalizeWholeAmount(row.cod_amount)!,
      delivery_fee: normalizeWholeAmount(row.delivery_fee, true),
      pieces,
    } satisfies PostalStatementPrintShipment,
  }
}

export function usePostalStatementPrint(input: PostalStatementPrintInput | null) {
  const queryInput = input ?? {
    workspaceId: '', userId: '', role: 'office' as const, permissionScope: '',
    organizationId: '', search: '', kind: 'all' as const,
  }

  return useQuery({
    queryKey: queryKeys.postal.statementPrint(queryInput),
    enabled: !!input && canReadPostalStatement(queryInput) && !!queryInput.organizationId,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: ({ signal }) => tracked(
      queryInput,
      postalStatementTables,
      signal,
      async () => {
        const rpcKind = queryInput.kind === 'all' && !postalStatementDisplayConfig.showRecipientCollectionRows
          ? 'organization'
          : queryInput.kind
        const readPage = async (page: number): Promise<PostalStatement> => {
          const { data, error } = await supabase.rpc('postal_organization_statement', {
            p_workspace_id: queryInput.workspaceId,
            p_organization_id: queryInput.organizationId,
            p_page: page,
            p_page_size: PAGE_SIZE,
            p_start: queryInput.start ?? null,
            p_end: queryInput.end ?? null,
            p_search: queryInput.search,
            p_kind: rpcKind,
          }).abortSignal(signal)
          if (error) throw error
          return normalizePostalStatement(data, queryInput.workspaceId, queryInput.organizationId)
        }

        const firstPage = await readPage(1)
        const { data: organizationRow, error: organizationError } = await supabase.from('postal_organizations')
          .select('id, workspace_id, name, phone, code, leader_id')
          .eq('workspace_id', queryInput.workspaceId)
          .eq('id', queryInput.organizationId)
          .abortSignal(signal)
          .single()
        if (organizationError) throw organizationError
        const organization = normalizePostalOrganization(organizationRow, queryInput.workspaceId)
        if (organization.id !== queryInput.organizationId) throw new Error('postal_invalid_result')
        const pageCount = Math.ceil(firstPage.total / PAGE_SIZE)
        const pageResults: PostalStatement[] = [firstPage]
        for (let firstPageNumber = 2; firstPageNumber <= pageCount; firstPageNumber += PAGE_BATCH_SIZE) {
          const pageNumbers = Array.from(
            { length: Math.min(PAGE_BATCH_SIZE, pageCount - firstPageNumber + 1) },
            (_, index) => firstPageNumber + index,
          )
          pageResults.push(...await Promise.all(pageNumbers.map(readPage)))
        }

        if (pageResults.some((page) => page.total !== firstPage.total
          || JSON.stringify(page.summary) !== JSON.stringify(firstPage.summary))) {
          throw new Error('postal_statement_changed_during_print')
        }
        const entries = pageResults.flatMap((page) => page.entries)
        if (entries.length !== firstPage.total || new Set(entries.map((entry) => `${entry.kind}:${entry.id}`)).size !== entries.length) {
          throw new Error('postal_statement_changed_during_print')
        }

        const shipmentIds = [...new Set(entries.map((entry) => entry.shipment_id))]
        const shipmentMap = new Map<string, PostalStatementPrintShipment>()
        for (let offset = 0; offset < shipmentIds.length; offset += PAGE_SIZE) {
          const ids = shipmentIds.slice(offset, offset + PAGE_SIZE)
          const { data, error } = await supabase.from('postal_shipments')
            .select('id, workspace_id, organization_id, qr_id, governorate, area, address, cod_amount, delivery_fee, pieces')
            .eq('workspace_id', queryInput.workspaceId)
            .eq('organization_id', queryInput.organizationId)
            .in('id', ids)
            .abortSignal(signal)
          if (error) throw error
          if (!Array.isArray(data)) throw new Error('postal_invalid_result')
          for (const raw of data) {
            const shipment = normalizeShipmentDetails(raw, queryInput.workspaceId, queryInput.organizationId)
            shipmentMap.set(shipment.id, shipment.details)
          }
        }
        if (shipmentMap.size !== shipmentIds.length) throw new Error('postal_invalid_result')

        const printEntries = entries.map((entry) => {
          const shipment = shipmentMap.get(entry.shipment_id)
          if (!shipment) throw new Error('postal_invalid_result')
          return { ...entry, shipment }
        })
        const shipments = new Map<string, string>()
        for (const entry of printEntries) shipments.set(entry.shipment_id, entry.shipment.governorate.toLowerCase())
        const shipmentLocations = [...shipments.values()]
        const printData: PostalStatementPrintData = {
          organization,
          entries: printEntries,
          shipment_counts: {
            total: shipments.size,
            baghdad: shipmentLocations.filter((location) => location === 'baghdad').length,
            provinces: shipmentLocations.filter((location) => location !== 'baghdad').length,
          },
          total: firstPage.total,
          summary: firstPage.summary,
          ...(queryInput.start ? { start: queryInput.start } : {}),
          ...(queryInput.end ? { end: queryInput.end } : {}),
          search: queryInput.search,
          kind: queryInput.kind,
          generated_at: new Date().toISOString(),
        }
        return { data: printData, error: null }
      },
      (data, table) => {
        if (table === 'postal_organizations') return 1
        if (table === 'postal_shipments') return new Set(data.entries.map((entry) => entry.shipment_id)).size
        if (table === 'postal_events') return data.entries.filter((entry) => entry.kind === 'delivery_accrual').length
        if (table === 'postal_delivery_fee_records') return data.entries.filter((entry) => entry.kind === 'delivery_fee').length
        if (table === 'postal_cod_records') return data.entries.filter((entry) => entry.kind === 'settlement' || entry.kind === 'collection').length
        if (table === 'payment_transactions') return new Set(data.entries.flatMap((entry) => entry.payment_transaction_id ? [entry.payment_transaction_id] : [])).size
        return data.entries.length
      },
    ),
  })
}
