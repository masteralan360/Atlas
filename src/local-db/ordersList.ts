import { useEffect, useMemo, useState } from 'react'
import Dexie, { type Table } from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { getActiveBusinessUserRole, isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { toCamelCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { useViewOwnRecordScope } from '@/permissions/useViewOwnRecordScope'
import { useOptionalWorkspacePermissions } from '@/permissions/workspacePermissionsState'

import { db } from './database'
import { getAccessibleBusinessPartnerFacetIdsInLocalCache, getAccessibleBusinessPartnerIdsInLocalCache } from './businessPartnerAccess'
import { getOrderBalanceAmount, getOrderPaymentStatus } from './orderInstallments'
import { getCurrentStorageAccess, redactPurchaseOrderForStorageAccess, redactSalesOrderForStorageAccess, useStorageAccess } from './storagePermissions'
import { getCommissionAssignedOrderAccess, getSalesOrderIdsAssignedToLinkedFieldAgent } from './orders'
import { getAppliedCurrencyConversion } from '@/lib/orderCurrency'
import type {
  Agent,
  ProductCommissionRule,
  ProductCommissionRuleAgent,
  PurchaseOrder,
  SalesOrder,
  SalesOrderAgentAssignment
} from './models'

export type OrdersListType = 'sales' | 'purchase'

export interface OrdersListPageQuery {
  workspaceId?: string
  orderType: OrdersListType
  createdFrom?: string
  createdTo?: string
  fulfilledFrom?: string
  fulfilledTo?: string
  status?: string
  paymentStatus?: string
  ecommerceFilter?: string
  commissionMode?: string
  search?: string
  includeArchived?: boolean
  page: number
  pageSize: number
  refreshToken?: number
  enabled?: boolean
}

export interface OrdersListPage {
  rows: Array<SalesOrder | PurchaseOrder>
  totalCount: number
  pageCount: number
  pendingCount: number
  minCreatedAt: string | null
  maxCreatedAt: string | null
  totalsByCurrency: Array<{ currency: string; total: number }>
  outstandingByCurrency: Array<{ currency: string; total: number; unpaidCount: number; partialCount: number }>
  productCommissionPreviewByCurrency: Array<{ currency: string; total: number; unavailableConversion: boolean }>
  productCommissionPreviewIsLoading?: boolean
  productCommissionPreviewError?: unknown | null
}

export interface OrdersProductCommissionPreviewContext {
  agents: readonly Agent[]
  rules: readonly ProductCommissionRule[]
  recipients: readonly ProductCommissionRuleAgent[]
  userId?: string
  canAssignSalesAgents: boolean
  canViewAllAgentCommissions: boolean
  canViewOwnAgentCommissions: boolean
}

const EMPTY_ORDERS_PAGE: OrdersListPage = {
  rows: [],
  totalCount: 0,
  pageCount: 1,
  pendingCount: 0,
  minCreatedAt: null,
  maxCreatedAt: null,
  totalsByCurrency: [],
  outstandingByCurrency: [],
  productCommissionPreviewByCurrency: []
}

type OrderListAccess = ReturnType<typeof useStorageAccess>
type LocalOrdersListContext = {
  storageAccess: OrderListAccess
  viewOwn: { isRestricted: boolean; userId?: string }
  permissionKeys?: readonly string[]
}

function normalizeOrder(value: unknown, workspaceId: string): SalesOrder | PurchaseOrder {
  const order = toCamelCase(value as Record<string, unknown>) as unknown as SalesOrder | PurchaseOrder
  order.workspaceId = workspaceId
  order.syncStatus = 'synced'
  order.lastSyncedAt = new Date().toISOString()
  order.isDeleted = false
  order.isArchived = order.isArchived === true
  order.items = Array.isArray(order.items) ? order.items : []
  order.total = Number(order.total ?? 0)
  order.subtotal = Number(order.subtotal ?? 0)
  order.discount = Number(order.discount ?? 0)
  order.paidAmount = Number(order.paidAmount ?? 0)
  order.balanceAmount = Number(order.balanceAmount ?? 0)
  return order
}

function matchesOrderFilters(
  order: SalesOrder | PurchaseOrder,
  query: OrdersListPageQuery,
  searchAgentOrderIds: ReadonlySet<string>
) {
  if (order.isDeleted) return false
  if (query.includeArchived ? !order.isArchived : order.isArchived) return false
  if (query.createdFrom && order.createdAt < query.createdFrom) return false
  if (query.createdTo && order.createdAt >= query.createdTo) return false
  if (query.fulfilledFrom && (!order.actualDeliveryDate || order.actualDeliveryDate < query.fulfilledFrom)) return false
  if (query.fulfilledTo && (!order.actualDeliveryDate || order.actualDeliveryDate >= query.fulfilledTo)) return false
  if (query.status && query.status !== 'all' && order.status !== query.status) return false

  const paymentStatus = getOrderPaymentStatus(order)
  if (query.paymentStatus === 'returned') {
    if (query.orderType !== 'sales' || (order as SalesOrder).returnStatus !== 'full') return false
  } else if (query.paymentStatus && query.paymentStatus !== 'all' && paymentStatus !== query.paymentStatus) {
    return false
  }

  if (query.orderType === 'sales') {
    const salesOrder = order as SalesOrder
    if (query.ecommerceFilter === 'ecommerce' && salesOrder.sourceChannel !== 'marketplace') return false
    if (query.ecommerceFilter === 'nonEcommerce' && salesOrder.sourceChannel === 'marketplace') return false
    if (query.commissionMode && query.commissionMode !== 'all') {
      const effectiveMode = salesOrder.commissionMode ?? (salesOrder.commissionEnabled === false ? null : 'payable')
      if (effectiveMode !== query.commissionMode) return false
    }
  }

  const search = query.search?.trim().toLocaleLowerCase() || ''
  if (!search) return true
  const counterparty = query.orderType === 'sales'
    ? (order as SalesOrder).customerName
    : (order as PurchaseOrder).supplierName
  return order.orderNumber.toLocaleLowerCase().includes(search)
    || counterparty.toLocaleLowerCase().includes(search)
    || order.items.some((item) => String(item.productName ?? '').toLocaleLowerCase().includes(search)
      || String(item.productSku ?? '').toLocaleLowerCase().includes(search))
    || searchAgentOrderIds.has(order.id)
}

async function readLocalOrdersListPage(
  query: OrdersListPageQuery,
  access: OrderListAccess,
  viewOwn: { isRestricted: boolean; userId?: string },
  permissionKeys: readonly string[] = [],
  commissionPreview?: OrdersProductCommissionPreviewContext
): Promise<OrdersListPage> {
  const workspaceId = query.workspaceId
  if (!workspaceId || !access.isReady) return EMPTY_ORDERS_PAGE

  const isSales = query.orderType === 'sales'
  const table = isSales ? db.sales_orders : db.purchase_orders
  const lower = query.createdFrom || Dexie.minKey
  const upper = query.createdTo || Dexie.maxKey
  const getBase = () => table.where('[workspaceId+createdAt]').between(
    [workspaceId, lower],
    [workspaceId, upper],
    true,
    Boolean(query.createdTo)
  )

  const search = query.search?.trim().toLocaleLowerCase() || ''
  const assignedOrderAccess = isSales && viewOwn.isRestricted
    ? getCommissionAssignedOrderAccess(workspaceId, permissionKeys)
    : 'none'
  const canViewAllSalesOrders = assignedOrderAccess === 'all'
  const canSearchAllAgentNames = permissionKeys.includes('salesAgentCommissions.viewAll')
    || permissionKeys.includes('salesAgentCommissions.assignOrders')
    || getActiveBusinessUserRole(workspaceId) === 'admin'
  const canSearchOwnAgentNames = permissionKeys.includes('salesAgentCommissions.viewOwn') && Boolean(viewOwn.userId)
  const needsAgentSearch = isSales && Boolean(search) && (canSearchAllAgentNames || canSearchOwnAgentNames)
  let assignedOrderIds = new Set<string>()
  let searchAgentOrderIds = new Set<string>()

  if (assignedOrderAccess === 'own' || assignedOrderAccess === 'assigned') {
    assignedOrderIds = await getSalesOrderIdsAssignedToLinkedFieldAgent(workspaceId, viewOwn.userId, assignedOrderAccess)
  }

  if (needsAgentSearch) {
    const agents = await db.agents.where('workspaceId').equals(workspaceId)
      .filter((agent) => !agent.isDeleted && agent.agentType === 'field_agent')
      .toArray()
    let matchingAgentIds: string[] = []
    const partnerIds = [...new Set(agents.map((agent) => agent.businessPartnerId))]
    const partners = await db.business_partners.bulkGet(partnerIds)
    const partnerNameById = new Map(partners
      .filter((partner) => Boolean(partner && !partner.isDeleted))
      .map((partner) => [partner!.id, partner!.partnerName.toLocaleLowerCase()] as const))
    matchingAgentIds = agents
      .filter((agent) => (canSearchAllAgentNames
        || (permissionKeys.includes('salesAgentCommissions.viewOwn') && agent.linkedUserId === viewOwn.userId))
        && (partnerNameById.get(agent.businessPartnerId) || '').includes(search))
      .map((agent) => agent.id)

    if (matchingAgentIds.length > 0) {
      const agentKeys = matchingAgentIds.map((agentId) => [workspaceId, agentId])
      const assignments = await db.sales_order_agent_assignments
        .where('[workspaceId+agentId]')
        .anyOf(agentKeys)
        .and((assignment) => !assignment.isDeleted)
        .toArray()
      const matchingAgentIdSet = new Set(matchingAgentIds)
      searchAgentOrderIds = new Set(assignments
        .filter((assignment) => matchingAgentIdSet.has(assignment.agentId) && !assignment.unassignedAt)
        .map((assignment) => assignment.orderId))
    }
  }

  const isInViewOwnScope = (order: SalesOrder | PurchaseOrder) => (
    !viewOwn.isRestricted
    || order.createdBy === viewOwn.userId
    || (isSales && canViewAllSalesOrders)
    || (isSales && assignedOrderIds.has(order.id))
  )
  const getVisibleMatchingOrder = (rawOrder: SalesOrder | PurchaseOrder) => {
    if (rawOrder.isDeleted || !isInViewOwnScope(rawOrder)) return null
    const order = isSales
      ? redactSalesOrderForStorageAccess(rawOrder as SalesOrder, access)
      : redactPurchaseOrderForStorageAccess(rawOrder as PurchaseOrder, access)
    return order && matchesOrderFilters(order, query, searchAgentOrderIds) ? order : null
  }

  // Resolve access only for partners referenced by matching orders. This keeps
  // privacy checks from loading every partner and facet in a large workspace.
  const candidatePartnerIds = new Set<string>()
  const candidateFacetIds = new Set<string>()
  await getBase().reverse().each((rawOrder) => {
    const order = getVisibleMatchingOrder(rawOrder as SalesOrder | PurchaseOrder)
    if (!order) return
    if (order.businessPartnerId) candidatePartnerIds.add(order.businessPartnerId)
    else {
      const facetId = isSales ? (order as SalesOrder).customerId : (order as PurchaseOrder).supplierId
      if (facetId) candidateFacetIds.add(facetId)
    }
  })
  const [accessiblePartners, accessibleFacets] = await Promise.all([
    getAccessibleBusinessPartnerIdsInLocalCache(workspaceId, [...candidatePartnerIds], isSales ? 'customer' : 'supplier'),
    getAccessibleBusinessPartnerFacetIdsInLocalCache(workspaceId, [...candidateFacetIds], isSales ? 'customer' : 'supplier')
  ])

  const totalsByCurrency = new Map<string, number>()
  const outstandingByCurrency = new Map<string, { total: number; unpaidCount: number; partialCount: number }>()
  const pageRows: Array<SalesOrder | PurchaseOrder> = []
  const commissionOrderIds: string[] = []
  let totalCount = 0
  let pendingCount = 0
  let minCreatedAt: string | null = null
  let maxCreatedAt: string | null = null
  const pageSize = Math.max(1, query.pageSize)
  const offset = (Math.max(1, query.page) - 1) * pageSize

  await getBase().reverse().each((rawOrder) => {
    const order = getVisibleMatchingOrder(rawOrder as SalesOrder | PurchaseOrder)
    if (!order) return

    const businessPartnerId = order.businessPartnerId
    const facetId = isSales ? (order as SalesOrder).customerId : (order as PurchaseOrder).supplierId
    if (businessPartnerId && !accessiblePartners.has(businessPartnerId)) return
    if (!businessPartnerId && facetId && !accessibleFacets.has(facetId)) return

    if (isSales && commissionPreview) commissionOrderIds.push(order.id)

    if (minCreatedAt === null || order.createdAt < minCreatedAt) minCreatedAt = order.createdAt
    if (maxCreatedAt === null || order.createdAt > maxCreatedAt) maxCreatedAt = order.createdAt
    totalCount += 1
    if (isSales && order.status === 'pending') pendingCount += 1
    if (order.status !== 'cancelled') {
      totalsByCurrency.set(order.currency, (totalsByCurrency.get(order.currency) || 0) + order.total)
    }

    const paymentStatus = getOrderPaymentStatus(order)
    if (order.status !== 'draft' && order.status !== 'cancelled' && order.status !== 'returned'
      && (!('returnStatus' in order) || order.returnStatus !== 'full')
      && paymentStatus !== 'paid') {
      const balance = getOrderBalanceAmount(order)
      if (balance > 0) {
        const summary = outstandingByCurrency.get(order.currency) || { total: 0, unpaidCount: 0, partialCount: 0 }
        summary.total += balance
        if (paymentStatus === 'partial') summary.partialCount += 1
        else summary.unpaidCount += 1
        outstandingByCurrency.set(order.currency, summary)
      }
    }

    const pagePosition = totalCount - 1
    if (pagePosition >= offset && pageRows.length < pageSize) pageRows.push(order)
  })

  const productCommissionPreviewByCurrency = isSales && commissionPreview
    ? await summarizeLocalProductCommissions(commissionOrderIds, workspaceId, access, commissionPreview)
    : []

  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize))
  return {
    rows: pageRows,
    totalCount,
    pageCount,
    pendingCount,
    minCreatedAt,
    maxCreatedAt,
    totalsByCurrency: Array.from(totalsByCurrency, ([currency, total]) => ({ currency, total })),
    outstandingByCurrency: Array.from(outstandingByCurrency, ([currency, summary]) => ({ currency, ...summary })),
    productCommissionPreviewByCurrency
  }
}

async function summarizeLocalProductCommissions(
  orderIds: readonly string[],
  workspaceId: string,
  access: OrderListAccess,
  context: OrdersProductCommissionPreviewContext
) {
  const totals = new Map<string, { total: number; unavailableConversion: boolean }>()
  const agentById = new Map(context.agents.map((agent) => [agent.id, agent]))
  const recipientsByRuleId = new Map<string, Set<string>>()
  for (const recipient of context.recipients) {
    if (recipient.isDeleted) continue
    const eligibleAgents = recipientsByRuleId.get(recipient.ruleId) || new Set<string>()
    eligibleAgents.add(recipient.agentId)
    recipientsByRuleId.set(recipient.ruleId, eligibleAgents)
  }
  const now = new Date().toISOString()
  const ruleByProductId = new Map<string, ProductCommissionRule>()
  for (const rule of context.rules) {
    const effectiveFrom = String(rule.effectiveFrom || rule.updatedAt || rule.createdAt || '')
    if (rule.isDeleted || !rule.isActive || effectiveFrom > now || (rule.effectiveTo && rule.effectiveTo <= now)) continue
    const current = ruleByProductId.get(rule.productId)
    const currentEffectiveFrom = String(current?.effectiveFrom || current?.updatedAt || current?.createdAt || '')
    if (!current || effectiveFrom > currentEffectiveFrom) ruleByProductId.set(rule.productId, rule)
  }

  for (let offset = 0; offset < orderIds.length; offset += 100) {
    const batchIds = orderIds.slice(offset, offset + 100)
    const assignmentKeys = batchIds.map((orderId) => [workspaceId, orderId])
    const [rawOrders, assignments] = await Promise.all([
      db.sales_orders.bulkGet(batchIds),
      db.sales_order_agent_assignments.where('[workspaceId+orderId]').anyOf(assignmentKeys).toArray()
    ])
    const assignmentsByOrderId = new Map<string, SalesOrderAgentAssignment[]>()
    for (const assignment of assignments) {
      if (assignment.isDeleted || assignment.unassignedAt) continue
      const current = assignmentsByOrderId.get(assignment.orderId) || []
      current.push(assignment)
      assignmentsByOrderId.set(assignment.orderId, current)
    }

    for (const rawOrder of rawOrders) {
      if (!rawOrder || rawOrder.workspaceId !== workspaceId) continue
      const order = redactSalesOrderForStorageAccess(rawOrder, access)
      if (!order) continue
      const agentIds = new Set((assignmentsByOrderId.get(order.id) || [])
        .filter((assignment) => {
          if (context.canAssignSalesAgents || context.canViewAllAgentCommissions) return true
          return context.canViewOwnAgentCommissions
            && Boolean(context.userId)
            && agentById.get(assignment.agentId)?.linkedUserId === context.userId
        })
        .map((assignment) => assignment.agentId))
      if ((Boolean(order.createdBy) && context.userId === order.createdBy)
        || context.canAssignSalesAgents || context.canViewAllAgentCommissions) {
        const creatorAgent = context.agents.find((agent) => (
          !agent.isDeleted
          && agent.status === 'active'
          && agent.agentType === 'field_agent'
          && agent.linkedUserId === order.createdBy
        ))
        if (creatorAgent) agentIds.add(creatorAgent.id)
      }

      const summary = totals.get(order.currency) || { total: 0, unavailableConversion: false }
      for (const item of order.items) {
        if (!(Number(item.quantity || 0) > 0)) continue
        const rule = ruleByProductId.get(item.productId)
        if (!rule) continue
        const eligibleAgentCount = rule.recipientScope === 'all_assigned'
          ? agentIds.size
          : [...agentIds].filter((agentId) => recipientsByRuleId.get(rule.id)?.has(agentId)).length
        if (eligibleAgentCount === 0) continue

        let perUnit = Math.max(0, Number(item.convertedUnitPrice || 0)) * Number(rule.ratePercent || 0) / 100
        if (rule.commissionType === 'fixed_amount') {
          const converted = rule.fixedCurrency
            ? getAppliedCurrencyConversion(
              Number(rule.fixedAmount || 0),
              rule.fixedCurrency,
              order.currency,
              order.exchangeRates || []
            )
            : null
          if (!converted) summary.unavailableConversion = true
          perUnit = converted?.convertedAmount || 0
        }
        summary.total += perUnit * Number(item.quantity || 0) * eligibleAgentCount
      }
      totals.set(order.currency, summary)
    }
  }

  return [...totals.entries()].map(([currency, summary]) => ({ currency, ...summary }))
}

export async function fetchOrdersListPage(
  query: OrdersListPageQuery,
  localContext?: LocalOrdersListContext,
  commissionPreview?: OrdersProductCommissionPreviewContext
): Promise<OrdersListPage> {
  const workspaceId = query.workspaceId
  if (!workspaceId || query.enabled === false) return EMPTY_ORDERS_PAGE

  if (isOnline(workspaceId) && !isLocalWorkspaceMode(workspaceId)) {
    const response = await runSupabaseAction('orders.listPage', () => getSupabaseClientForTable(
      query.orderType === 'sales' ? 'sales_orders' : 'purchase_orders'
    ).rpc('get_orders_list_page_optimized', {
      p_workspace_id: workspaceId,
      p_order_type: query.orderType,
      p_created_from: query.createdFrom ?? null,
      p_created_to: query.createdTo ?? null,
      p_fulfilled_from: query.fulfilledFrom ?? null,
      p_fulfilled_to: query.fulfilledTo ?? null,
      p_status: query.status ?? 'all',
      p_payment_status: query.paymentStatus ?? 'all',
      p_ecommerce_filter: query.ecommerceFilter ?? 'all',
      p_commission_mode: query.commissionMode ?? 'all',
      p_search: query.search ?? '',
      p_include_archived: query.includeArchived ?? false,
      p_page: query.page,
      p_page_size: query.pageSize,
      p_include_product_commission_preview: false
    }))

    if (response.error) throw normalizeSupabaseActionError(response.error)
    const payload = response.data as Record<string, unknown> | null
    if (!payload || !Array.isArray(payload.orders)) throw new Error('Invalid orders list response.')

    const fetchedAt = new Date().toISOString()
    const rows = payload.orders.map((value) => {
      const row = normalizeOrder(value, workspaceId)
      row.lastSyncedAt = fetchedAt
      return row
    })
    const table = (query.orderType === 'sales' ? db.sales_orders : db.purchase_orders) as unknown as Table<SalesOrder | PurchaseOrder, string>
    if (rows.length > 0) {
      const existingRows = await table.bulkGet(rows.map((row) => row.id))
      const cacheRows = rows.filter((row, index) => {
        const existing = existingRows[index]
        if (!existing) return true
        if (existing.syncStatus === 'pending' || existing.syncStatus === 'conflict') return false
        const existingUpdatedAt = Date.parse(existing.updatedAt || '')
        const remoteUpdatedAt = Date.parse(row.updatedAt || '')
        return !Number.isFinite(existingUpdatedAt) || !Number.isFinite(remoteUpdatedAt) || remoteUpdatedAt >= existingUpdatedAt
      })
      if (cacheRows.length > 0) await table.bulkPut(cacheRows as never[])
    }

    const asNumber = (value: unknown) => Number(value) || 0
    const totals = Array.isArray(payload.totals_by_currency) ? payload.totals_by_currency as Array<Record<string, unknown>> : []
    const outstanding = Array.isArray(payload.outstanding_by_currency) ? payload.outstanding_by_currency as Array<Record<string, unknown>> : []
    const commissionPreviewTotals = Array.isArray(payload.product_commission_preview_by_currency)
      ? payload.product_commission_preview_by_currency as Array<Record<string, unknown>>
      : []
    return {
      rows,
      totalCount: asNumber(payload.total_count),
      pageCount: Math.max(1, asNumber(payload.page_count)),
      pendingCount: asNumber(payload.pending_count),
      minCreatedAt: typeof payload.min_created_at === 'string' ? payload.min_created_at : null,
      maxCreatedAt: typeof payload.max_created_at === 'string' ? payload.max_created_at : null,
      totalsByCurrency: totals.map((entry) => ({ currency: String(entry.currency || 'usd'), total: asNumber(entry.total) })),
      outstandingByCurrency: outstanding.map((entry) => ({
        currency: String(entry.currency || 'usd'),
        total: asNumber(entry.total),
        unpaidCount: asNumber(entry.unpaid_count),
        partialCount: asNumber(entry.partial_count)
      })),
      productCommissionPreviewByCurrency: commissionPreviewTotals.map((entry) => ({
        currency: String(entry.currency || 'usd'),
        total: asNumber(entry.total),
        unavailableConversion: entry.unavailable_conversion === true
      }))
    }
  }

  const storageAccess = localContext?.storageAccess ?? await getLocalStorageAccessSnapshot(workspaceId)
  const viewOwn = localContext?.viewOwn ?? { isRestricted: false }
  return readLocalOrdersListPage(query, storageAccess, viewOwn, localContext?.permissionKeys, commissionPreview)
}

async function fetchRemoteProductCommissionPreview(query: OrdersListPageQuery) {
  const workspaceId = query.workspaceId
  if (!workspaceId) return []

  const response = await runSupabaseAction('orders.productCommissionPreview', () => getSupabaseClientForTable('sales_orders')
    .rpc('get_orders_list_page_optimized', {
      p_workspace_id: workspaceId,
      p_order_type: 'sales',
      p_created_from: query.createdFrom ?? null,
      p_created_to: query.createdTo ?? null,
      p_fulfilled_from: query.fulfilledFrom ?? null,
      p_fulfilled_to: query.fulfilledTo ?? null,
      p_status: query.status ?? 'all',
      p_payment_status: query.paymentStatus ?? 'all',
      p_ecommerce_filter: query.ecommerceFilter ?? 'all',
      p_commission_mode: query.commissionMode ?? 'all',
      p_search: query.search ?? '',
      p_include_archived: query.includeArchived ?? false,
      p_page: 1,
      p_page_size: 1,
      p_include_product_commission_preview: true
    }))

  if (response.error) throw normalizeSupabaseActionError(response.error)
  const payload = response.data as Record<string, unknown> | null
  if (!payload) throw new Error('Invalid commission preview response.')
  const totals = Array.isArray(payload.product_commission_preview_by_currency)
    ? payload.product_commission_preview_by_currency as Array<Record<string, unknown>>
    : []
  return totals.map((entry) => ({
    currency: String(entry.currency || 'usd'),
    total: Number(entry.total) || 0,
    unavailableConversion: entry.unavailable_conversion === true
  }))
}

async function getLocalStorageAccessSnapshot(workspaceId: string): Promise<OrderListAccess> {
  const access = await getCurrentStorageAccess(workspaceId)
  return {
    ...access,
    signature: `${access.isReady === false ? 'resolving' : access.isAdmin ? 'admin' : 'member'}:${Array.from(access.excludedStorageIds).sort().join('|')}`,
    canAccessStorage: (storageId) => !storageId || access.isAdmin || !access.excludedStorageIds.has(storageId),
    filterStorageScopedRows: (rows) => access.isAdmin ? [...rows] : rows.filter((row) => !row.storageId || !access.excludedStorageIds.has(row.storageId)),
    filterProducts: (products) => [...products]
  }
}

export function useOrdersListPage(query: OrdersListPageQuery, commissionPreview?: OrdersProductCommissionPreviewContext) {
  const online = useNetworkStatus()
  const queryKey = useMemo(() => JSON.stringify(query), [query])
  const request = useMemo(() => JSON.parse(queryKey) as OrdersListPageQuery, [queryKey])
  const workspaceId = request.workspaceId
  const commissionSummaryQueryKey = useMemo(() => JSON.stringify({ ...request, page: 1, pageSize: 100 }), [
    request.workspaceId,
    request.orderType,
    request.createdFrom,
    request.createdTo,
    request.fulfilledFrom,
    request.fulfilledTo,
    request.status,
    request.paymentStatus,
    request.ecommerceFilter,
    request.commissionMode,
    request.search,
    request.includeArchived,
    request.refreshToken,
    request.enabled
  ])
  const commissionSummaryRequest = useMemo(
    () => JSON.parse(commissionSummaryQueryKey) as OrdersListPageQuery,
    [commissionSummaryQueryKey]
  )
  const storageAccess = useStorageAccess(workspaceId)
  const viewOwn = useViewOwnRecordScope('orders.view_own')
  const permissions = useOptionalWorkspacePermissions()
  const usesRemote = Boolean(workspaceId && online && !isLocalWorkspaceMode(workspaceId))
  const localPage = useLiveQuery(
    () => request.enabled === false || usesRemote
      ? EMPTY_ORDERS_PAGE
      : readLocalOrdersListPage(request, storageAccess, viewOwn, permissions?.permissionKeys),
    [request, storageAccess.signature, viewOwn.isRestricted, viewOwn.userId, permissions?.permissionKeys, usesRemote],
    EMPTY_ORDERS_PAGE
  )
  const localCommissionPreview = useLiveQuery(
    () => request.enabled === false || usesRemote || !commissionPreview
      ? []
      : readLocalOrdersListPage(
        commissionSummaryRequest,
        storageAccess,
        viewOwn,
        permissions?.permissionKeys,
        commissionPreview
      ).then((page) => page.productCommissionPreviewByCurrency),
    [
      commissionSummaryQueryKey,
      storageAccess.signature,
      viewOwn.isRestricted,
      viewOwn.userId,
      permissions?.permissionKeys,
      usesRemote,
      commissionPreview
    ],
    []
  )
  const [remoteState, setRemoteState] = useState<{ key: string; page: OrdersListPage; loading: boolean; error: unknown }>({
    key: '',
    page: EMPTY_ORDERS_PAGE,
    loading: false,
    error: null
  })
  const [remoteCommissionPreviewState, setRemoteCommissionPreviewState] = useState<{
    key: string
    totals: OrdersListPage['productCommissionPreviewByCurrency']
    loading: boolean
    error: unknown | null
  }>({ key: '', totals: [], loading: false, error: null })
  const fetchAllMatches = () => fetchAllOrdersListMatches(request, {
    storageAccess,
    viewOwn,
    permissionKeys: permissions?.permissionKeys
  })

  useEffect(() => {
    if (!request.enabled || !workspaceId || !usesRemote) {
      setRemoteState((current) => current.key === queryKey && !current.loading
        ? current
        : { key: queryKey, page: EMPTY_ORDERS_PAGE, loading: false, error: null })
      return
    }

    let cancelled = false
    setRemoteState((current) => ({ ...current, key: queryKey, loading: true, error: null }))
    void fetchOrdersListPage(request, undefined, commissionPreview)
      .then((page) => {
        if (!cancelled) setRemoteState({ key: queryKey, page, loading: false, error: null })
      })
      .catch((error) => {
        if (!cancelled) setRemoteState({ key: queryKey, page: EMPTY_ORDERS_PAGE, loading: false, error })
      })

    return () => { cancelled = true }
  }, [queryKey, request, usesRemote, workspaceId])

  useEffect(() => {
    if (!request.enabled || !workspaceId || !usesRemote || request.orderType !== 'sales' || !commissionPreview) {
      setRemoteCommissionPreviewState((current) => current.key === commissionSummaryQueryKey && !current.loading
        ? current
        : { key: commissionSummaryQueryKey, totals: [], loading: false, error: null })
      return
    }

    let cancelled = false
    setRemoteCommissionPreviewState((current) => ({
      key: commissionSummaryQueryKey,
      totals: current.key === commissionSummaryQueryKey ? current.totals : [],
      loading: true,
      error: null
    }))
    void fetchRemoteProductCommissionPreview(commissionSummaryRequest)
      .then((totals) => {
        if (!cancelled) setRemoteCommissionPreviewState({ key: commissionSummaryQueryKey, totals, loading: false, error: null })
      })
      .catch((error) => {
        if (!cancelled) setRemoteCommissionPreviewState({ key: commissionSummaryQueryKey, totals: [], loading: false, error })
      })

    return () => { cancelled = true }
  }, [commissionPreview, commissionSummaryQueryKey, commissionSummaryRequest, request.enabled, request.orderType, usesRemote, workspaceId])

  if (request.enabled === false) return {
    ...EMPTY_ORDERS_PAGE,
    isLoading: false,
    error: null,
    productCommissionPreviewIsLoading: false,
    productCommissionPreviewError: null,
    fetchAllMatches
  }
  if (usesRemote) {
    const current = remoteState.key === queryKey
    const currentCommissionPreview = remoteCommissionPreviewState.key === commissionSummaryQueryKey
    return {
      ...remoteState.page,
      productCommissionPreviewByCurrency: currentCommissionPreview ? remoteCommissionPreviewState.totals : [],
      productCommissionPreviewIsLoading: Boolean(commissionPreview)
        && (!currentCommissionPreview || remoteCommissionPreviewState.loading),
      productCommissionPreviewError: currentCommissionPreview ? remoteCommissionPreviewState.error : null,
      isLoading: !current || remoteState.loading,
      error: current ? remoteState.error : null,
      fetchAllMatches
    }
  }

  return {
    ...(localPage || EMPTY_ORDERS_PAGE),
    productCommissionPreviewByCurrency: localCommissionPreview || [],
    productCommissionPreviewIsLoading: false,
    productCommissionPreviewError: null,
    isLoading: localPage === undefined,
    error: null,
    fetchAllMatches
  }
}

export async function fetchAllOrdersListMatches(
  query: Omit<OrdersListPageQuery, 'page' | 'pageSize'>,
  localContext?: LocalOrdersListContext
) {
  const pageSize = 100
  const firstPage = await fetchOrdersListPage({ ...query, page: 1, pageSize }, localContext)
  const rows = [...firstPage.rows]
  for (let page = 2; page <= firstPage.pageCount; page += 1) {
    const next = await fetchOrdersListPage({ ...query, page, pageSize }, localContext)
    rows.push(...next.rows)
  }
  return rows
}

