import Dexie from 'dexie'
import { useQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { toCamelCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { useViewOwnRecordScope } from '@/permissions/useViewOwnRecordScope'
import { queryKeys } from '@/query/queryKeys'
import {
  cancelWorkspaceDataHydration,
  completeWorkspaceDataHydration,
  failWorkspaceDataHydration,
  recordWorkspaceDataFetch,
  startWorkspaceDataHydration,
  updateWorkspaceDataHydrationProgress,
} from '@/workspace/workspaceDataFreshness'
import { db } from './database'
import type { Invoice } from './models'

export interface InvoiceHistoryPageQuery {
  workspaceId?: string
  createdFrom?: string
  createdTo?: string
  search?: string
  page: number
  pageSize: number
  sortDirection?: 'asc' | 'desc'
  origin?: 'history' | 'upload'
  enabled?: boolean
  viewOwn?: boolean
  userId?: string
}

export interface InvoiceHistoryPage {
  invoices: Invoice[]
  totalCount: number
  pageCount: number
  minCreatedAt: string | null
  maxCreatedAt: string | null
  totalUploadCount: number
  totalUploadSize: number
}

const EMPTY_PAGE: InvoiceHistoryPage = {
  invoices: [],
  totalCount: 0,
  pageCount: 1,
  minCreatedAt: null,
  maxCreatedAt: null,
  totalUploadCount: 0,
  totalUploadSize: 0,
}

function matchesInvoiceSearch(invoice: Invoice, search: string) {
  if (!search) return true
  const needle = search.trim().toLocaleLowerCase()
  if (!needle) return true
  return [invoice.invoiceid, invoice.sourceId, invoice.origin, invoice.createdByName]
    .some((value) => value?.toLocaleLowerCase().includes(needle))
}

async function readLocalInvoiceHistoryPage(query: InvoiceHistoryPageQuery): Promise<InvoiceHistoryPage> {
  const workspaceId = query.workspaceId
  if (!workspaceId) return EMPTY_PAGE

  const lowerBound: [string, string | number | void[][], string | number | void[][]] = [
    workspaceId,
    query.createdFrom ?? Dexie.minKey,
    Dexie.minKey,
  ]
  const upperBound: [string, string | number | void[][], string | number | void[][]] = [
    workspaceId,
    query.createdTo ?? Dexie.maxKey,
    Dexie.maxKey,
  ]
  const pageSize = Math.min(100, Math.max(1, query.pageSize))
  const offset = (Math.max(1, query.page) - 1) * pageSize
  const isUploadPage = (query.origin ?? 'history') === 'upload'
  const collection = isUploadPage
    ? db.invoices.where('[workspaceId+origin+createdAt+id]').between(
      [workspaceId, 'upload', Dexie.minKey, Dexie.minKey],
      [workspaceId, 'upload', Dexie.maxKey, Dexie.maxKey],
      true,
      true,
    )
    : db.invoices
      .where('[workspaceId+createdAt+id]')
      .between(lowerBound, upperBound, true, !query.createdTo)
  const pageRows: Invoice[] = []
  let totalCount = 0
  let minCreatedAt: string | null = null
  let maxCreatedAt: string | null = null
  let totalUploadCount = 0
  let totalUploadSize = 0

  await (query.sortDirection === 'asc' ? collection : collection.reverse()).each((invoice) => {
    if (invoice.isDeleted) return
    if (query.viewOwn && invoice.createdBy !== query.userId && invoice.userId !== query.userId) return
    if (invoice.origin === 'upload') {
      totalUploadCount += 1
      totalUploadSize += Number(invoice.fileSize) || 0
    }
    if ((query.origin ?? 'history') === 'upload' ? invoice.origin !== 'upload' : invoice.origin === 'upload') return
    if (query.createdFrom && invoice.createdAt < query.createdFrom) return
    if (query.createdTo && invoice.createdAt >= query.createdTo) return
    if (!matchesInvoiceSearch(invoice, query.search ?? '')) return

    minCreatedAt = minCreatedAt === null || invoice.createdAt < minCreatedAt ? invoice.createdAt : minCreatedAt
    maxCreatedAt = maxCreatedAt === null || invoice.createdAt > maxCreatedAt ? invoice.createdAt : maxCreatedAt
    if (totalCount >= offset && pageRows.length < pageSize) pageRows.push(invoice)
    totalCount += 1
  })

  return {
    invoices: pageRows,
    totalCount,
    pageCount: Math.max(1, Math.ceil(totalCount / pageSize)),
    minCreatedAt,
    maxCreatedAt,
    totalUploadCount,
    totalUploadSize,
  }
}

export async function fetchInvoiceHistoryPage(query: InvoiceHistoryPageQuery, signal?: AbortSignal): Promise<InvoiceHistoryPage> {
  if (!query.workspaceId) return EMPTY_PAGE

  const operationId = JSON.stringify([
    query.page,
    query.pageSize,
    query.createdFrom,
    query.createdTo,
    query.search?.trim() ?? '',
  ])
  startWorkspaceDataHydration(query.workspaceId, 'supabase', 'invoices', operationId)

  try {
    const response = await runSupabaseAction('invoices.historyPage', () =>
      getSupabaseClientForTable('invoices').rpc('get_invoice_history_page', {
        p_workspace_id: query.workspaceId,
        p_created_from: query.createdFrom ?? null,
        p_created_to: query.createdTo ?? null,
        p_search: query.search ?? '',
        p_page: query.page,
        p_page_size: Math.min(100, Math.max(1, query.pageSize)),
        p_sort_direction: query.sortDirection ?? 'desc',
        p_origin: query.origin ?? 'history',
      }).abortSignal(signal ?? new AbortController().signal),
    )

    if (signal?.aborted) {
      cancelWorkspaceDataHydration(query.workspaceId, 'supabase', 'invoices', operationId)
      return EMPTY_PAGE
    }
    if (response.error) throw normalizeSupabaseActionError(response.error)
    const payload = response.data as Record<string, unknown> | null
    if (!payload || !Array.isArray(payload.invoices)) {
      throw new Error('Invalid invoice history response.')
    }

    const fetchedAt = new Date().toISOString()
    const remoteInvoices = payload.invoices.map((row) => {
      const invoice = toCamelCase(row as Record<string, unknown>) as unknown as Invoice
      invoice.syncStatus = 'synced'
      invoice.lastSyncedAt = fetchedAt
      return invoice
    })
    const existingRows = await db.invoices.bulkGet(remoteInvoices.map((invoice) => invoice.id))
    const cacheRows: Invoice[] = []
    const invoices = remoteInvoices.map((remoteInvoice, index) => {
      const existing = existingRows[index]
      if (existing?.syncStatus === 'pending' || existing?.syncStatus === 'conflict') {
        return existing
      }

      const cachedInvoice: Invoice = {
        ...remoteInvoice,
        localPathA4: existing?.localPathA4,
        localPathReceipt: existing?.localPathReceipt,
        pdfBlobA4: existing?.pdfBlobA4,
        pdfBlobReceipt: existing?.pdfBlobReceipt,
      }
      cacheRows.push(cachedInvoice)
      return cachedInvoice
    })

    if (signal?.aborted) {
      cancelWorkspaceDataHydration(query.workspaceId, 'supabase', 'invoices', operationId)
      return EMPTY_PAGE
    }
    if (cacheRows.length > 0) await db.invoices.bulkPut(cacheRows)

    const totalCount = Number(payload.total_count) || 0
    recordWorkspaceDataFetch(query.workspaceId, 'supabase', fetchedAt, 'invoices')
    updateWorkspaceDataHydrationProgress(query.workspaceId, 'supabase', 'invoices', invoices.length, operationId)
    completeWorkspaceDataHydration(query.workspaceId, 'supabase', 'invoices', undefined, operationId)

    return {
      invoices,
      totalCount,
      pageCount: Math.max(1, Math.ceil(totalCount / Math.max(1, query.pageSize))),
      minCreatedAt: typeof payload.min_created_at === 'string' ? payload.min_created_at : null,
      maxCreatedAt: typeof payload.max_created_at === 'string' ? payload.max_created_at : null,
      totalUploadCount: Number(payload.total_upload_count) || 0,
      totalUploadSize: Number(payload.total_upload_size) || 0,
    }
  } catch (error) {
    if (signal?.aborted) {
      cancelWorkspaceDataHydration(query.workspaceId, 'supabase', 'invoices', operationId)
    } else {
      failWorkspaceDataHydration(query.workspaceId, 'supabase', 'invoices', undefined, operationId)
    }
    throw error
  }
}

export function useInvoiceHistoryPage(query: InvoiceHistoryPageQuery) {
  const online = useNetworkStatus()
  const viewOwnScope = useViewOwnRecordScope('invoice_history.view_own')
  const scopedQuery = {
    ...query,
    viewOwn: viewOwnScope.isRestricted,
    userId: viewOwnScope.userId,
  }
  const enabled = query.enabled !== false
  const usesRemote = Boolean(enabled && query.workspaceId && online && !isLocalWorkspaceMode(query.workspaceId))
  const remotePage = useQuery({
    queryKey: queryKeys.invoiceHistory.page(scopedQuery as InvoiceHistoryPageQuery & { viewOwn: boolean; userId?: string }),
    queryFn: ({ signal }) => fetchInvoiceHistoryPage(scopedQuery, signal),
    enabled: usesRemote,
  })
  const remoteIdsKey = remotePage.data?.invoices.map((invoice) => invoice.id).join('|') ?? ''
  const cachedRemoteRows = useLiveQuery(
    async () => remoteIdsKey
      ? db.invoices.bulkGet(remoteIdsKey.split('|'))
      : [],
    [remoteIdsKey],
    [],
  )
  const localPage = useLiveQuery(
    () => usesRemote ? EMPTY_PAGE : readLocalInvoiceHistoryPage(scopedQuery),
    [
      query.workspaceId,
      query.createdFrom,
      query.createdTo,
      query.search,
      query.page,
      query.pageSize,
      query.sortDirection,
      query.origin,
      enabled,
      viewOwnScope.isRestricted,
      viewOwnScope.userId,
      usesRemote,
    ],
  )

  const cachedRowsById = new Map((cachedRemoteRows ?? []).filter(Boolean).map((invoice) => [invoice!.id, invoice!]))
  const remoteInvoices = (remotePage.data?.invoices ?? []).map((invoice) => {
    const cached = cachedRowsById.get(invoice.id)
    return cached?.syncStatus === 'pending' || cached?.syncStatus === 'conflict' ? cached : {
      ...invoice,
      localPathA4: cached?.localPathA4 ?? invoice.localPathA4,
      localPathReceipt: cached?.localPathReceipt ?? invoice.localPathReceipt,
      pdfBlobA4: cached?.pdfBlobA4 ?? invoice.pdfBlobA4,
      pdfBlobReceipt: cached?.pdfBlobReceipt ?? invoice.pdfBlobReceipt,
    }
  })
  const page = usesRemote ? {
    ...(remotePage.data ?? EMPTY_PAGE),
    invoices: remoteInvoices,
  } : (localPage ?? EMPTY_PAGE)

  return {
    ...page,
    isLoading: usesRemote ? remotePage.isPending : localPage === undefined,
    error: usesRemote ? remotePage.error : null,
    refetch: remotePage.refetch,
  }
}

