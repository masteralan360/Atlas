import { supabase } from '@/auth/supabase'
import type { MarketplaceSalesOrderReturnStatus } from '@/lib/marketplaceOrderPresentation'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import type { MarketplaceOrderItemRecord, MarketplaceOrderRecord, MarketplaceOrderStatus } from '@/ui/components/ecommerce/MarketplaceOrderTypes'
import {
    cancelWorkspaceDataHydration,
    completeWorkspaceDataHydration,
    failWorkspaceDataHydration,
    recordWorkspaceDataFetch,
    startWorkspaceDataHydration,
    updateWorkspaceDataHydrationProgress
} from '@/workspace/workspaceDataFreshness'

const MARKETPLACE_ORDER_SELECT = `
    id,
    workspace_id,
    order_number,
    business_partner_id,
    customer_id,
    sales_order_id,
    customer_name,
    customer_phone,
    customer_email,
    customer_address,
    customer_city,
    customer_notes,
    inquiry_pdf_storage_id,
    inquiry_pdf_document_number,
    inquiry_pdf_uploaded_at,
    website_storefront_key,
    items,
    subtotal,
    total,
    currency,
    status,
    confirmed_at,
    processing_at,
    shipped_at,
    shipped_by,
    shipped_by_name,
    delivered_at,
    delivered_by,
    delivered_by_name,
    cancelled_at,
    cancel_reason,
    inventory_deducted,
    created_at,
    updated_at
`

type MarketplaceOrderDatabaseRecord = Omit<MarketplaceOrderRecord, 'delivery_fee' | 'sales_order_return_status' | 'sales_order_returned_at'> & {
    website_storefront_key: string | null
}

type MarketplaceSalesOrderReturnRecord = {
    id: string
    return_status: MarketplaceSalesOrderReturnStatus
    returned_at: string | null
}

const MARKETPLACE_ORDER_STATUSES: MarketplaceOrderStatus[] = [
    'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'
]
const JUMLA_KHALEEJ_STOREFRONT_KEY = 'jumla-khaleej'
const JUMLA_KHALEEJ_DELIVERY_METADATA_TYPE = 'jumla_khaleej_delivery_fee'
let marketplaceHydrationSequence = 0

export type MarketplaceOrderSortColumn = 'created_at' | 'order_number' | 'customer_name' | 'total'

export interface MarketplaceOrderPageQuery {
    workspaceId: string
    page: number
    pageSize: number
    search: string
    status: 'all' | MarketplaceOrderStatus
    createdFrom?: string
    createdBefore?: string
    sortBy: MarketplaceOrderSortColumn
    sortDirection: 'asc' | 'desc'
}

export interface MarketplaceOrderPage {
    items: MarketplaceOrderRecord[]
    totalCount: number
}

export interface MarketplaceOrderSummaryQuery {
    workspaceId: string
    createdFrom?: string
    createdBefore?: string
    previousFrom?: string
    previousBefore?: string
}

export interface MarketplaceOrderSummary {
    totalCount: number
    pendingCount: number
    pendingFulfillmentCount: number
    deliveredCount: number
    cancelledCount: number
    orderValueByCurrency: Array<{ currency: string; total: number }>
    previousCount: number | null
    minCreatedAt: string | null
    maxCreatedAt: string | null
}

function isMarketplaceOrderStatus(value: unknown): value is MarketplaceOrderStatus {
    return typeof value === 'string' && MARKETPLACE_ORDER_STATUSES.includes(value as MarketplaceOrderStatus)
}

function isMarketplaceOrderItem(value: unknown): value is MarketplaceOrderItemRecord {
    return Boolean(value
        && typeof value === 'object'
        && typeof (value as { product_id?: unknown }).product_id === 'string'
        && (value as { product_id: string }).product_id.length > 0)
}

function getJumlaKhaleejDeliveryFee(items: unknown[], storefrontKey: string | null) {
    if (storefrontKey !== JUMLA_KHALEEJ_STOREFRONT_KEY) return null
    const metadata = items.find((item) => Boolean(
        item
        && typeof item === 'object'
        && (item as { metadata_type?: unknown }).metadata_type === JUMLA_KHALEEJ_DELIVERY_METADATA_TYPE
    )) as { delivery_fee?: unknown } | undefined
    const fee = Number(metadata?.delivery_fee)
    return Number.isInteger(fee) && fee > 0 ? fee : null
}

function normalizeMarketplaceOrder(
    order: MarketplaceOrderDatabaseRecord,
    salesOrderReturn?: MarketplaceSalesOrderReturnRecord,
    expectedWorkspaceId?: string
): MarketplaceOrderRecord {
    if (!order.id || !order.workspace_id || (expectedWorkspaceId && order.workspace_id !== expectedWorkspaceId)
        || !isMarketplaceOrderStatus(order.status)
        || !Number.isFinite(Number(order.total)) || !Number.isFinite(Number(order.subtotal))
        || !Number.isFinite(Date.parse(order.created_at))) {
        throw new Error('Invalid marketplace order result')
    }
    const rawItems: unknown[] = Array.isArray(order.items) ? order.items : []
    return {
        ...order,
        total: Number(order.total),
        subtotal: Number(order.subtotal),
        items: rawItems.filter(isMarketplaceOrderItem),
        delivery_fee: getJumlaKhaleejDeliveryFee(rawItems, order.website_storefront_key),
        sales_order_return_status: salesOrderReturn?.return_status ?? 'none',
        sales_order_returned_at: salesOrderReturn?.returned_at ?? null
    }
}

function escapePostgrestSearch(value: string) {
    return value.replace(/[\\%_,()]/g, '\\$&')
}

async function loadSalesOrderReturns(
    workspaceId: string,
    salesOrderIds: string[],
    signal?: AbortSignal
) {
    const returnsById = new Map<string, MarketplaceSalesOrderReturnRecord>()
    if (!salesOrderIds.length) return returnsById

    let request = supabase
        .schema('crm')
        .from('sales_orders')
        .select('id, return_status, returned_at')
        .eq('workspace_id', workspaceId)
        .in('id', salesOrderIds)
    if (signal) request = request.abortSignal(signal)
    const { data, error } = await runSupabaseAction('ecommerce.fetchLinkedSalesOrderReturns', () => request, { signal }) as {
            data: MarketplaceSalesOrderReturnRecord[] | null
            error: Error | null
        }
    if (error) throw error
    for (const salesOrder of data ?? []) {
        if (salesOrder.id && ['none', 'partial', 'full'].includes(salesOrder.return_status)) {
            returnsById.set(salesOrder.id, salesOrder)
        }
    }
    return returnsById
}

async function fetchMarketplaceOrders(
    workspaceId: string,
    buildQuery: (signal?: AbortSignal) => PromiseLike<{
        data: MarketplaceOrderDatabaseRecord[] | null
        error: Error | null
        count?: number | null
    }>,
    signal?: AbortSignal
) {
    const operationId = `ecommerce-order-page-${Date.now()}-${++marketplaceHydrationSequence}`
    const marketplaceSettled = { value: false }
    const salesOrdersSettled = { value: false }
    startWorkspaceDataHydration(workspaceId, 'supabase', 'marketplace_orders', operationId)
    startWorkspaceDataHydration(workspaceId, 'supabase', 'crm.sales_orders', operationId)

    try {
        const { data, error, count } = await runSupabaseAction(
            'ecommerce.fetchOrdersPage',
            () => buildQuery(signal),
            { signal }
        )
        if (error) throw error
        const rawOrders = data ?? []
        const invalidOrder = rawOrders.find((order) => order.workspace_id !== workspaceId
            || !order.id || !isMarketplaceOrderStatus(order.status)
            || !Number.isFinite(Number(order.total)) || !Number.isFinite(Number(order.subtotal))
            || !Number.isFinite(Date.parse(order.created_at)))
        if (invalidOrder) throw new Error('Invalid marketplace order result')
        updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', 'marketplace_orders', rawOrders.length, operationId)
        completeWorkspaceDataHydration(workspaceId, 'supabase', 'marketplace_orders', undefined, operationId)
        recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, 'marketplace_orders')
        marketplaceSettled.value = true

        const salesOrderIds = [...new Set(rawOrders
            .map((order) => order.sales_order_id)
            .filter((salesOrderId): salesOrderId is string => Boolean(salesOrderId)))]
        const returnsById = await loadSalesOrderReturns(workspaceId, salesOrderIds, signal)
        updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', 'crm.sales_orders', returnsById.size, operationId)
        completeWorkspaceDataHydration(workspaceId, 'supabase', 'crm.sales_orders', undefined, operationId)
        recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, 'crm.sales_orders')
        salesOrdersSettled.value = true

        signal?.throwIfAborted()
        const totalCount = Number(count)
        if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw new Error('Invalid marketplace order count')
        return {
            items: rawOrders.map((order) => normalizeMarketplaceOrder(
                order,
                order.sales_order_id ? returnsById.get(order.sales_order_id) : undefined,
                workspaceId
            )),
            totalCount
        }
    } catch (error) {
        const cancelled = Boolean(signal?.aborted)
        if (!marketplaceSettled.value) {
            if (cancelled) cancelWorkspaceDataHydration(workspaceId, 'supabase', 'marketplace_orders', operationId)
            else failWorkspaceDataHydration(workspaceId, 'supabase', 'marketplace_orders', undefined, operationId)
        }
        if (!salesOrdersSettled.value) {
            if (cancelled) cancelWorkspaceDataHydration(workspaceId, 'supabase', 'crm.sales_orders', operationId)
            else failWorkspaceDataHydration(workspaceId, 'supabase', 'crm.sales_orders', undefined, operationId)
        }
        throw error
    }
}

export async function fetchMarketplaceOrderPage(
    query: MarketplaceOrderPageQuery,
    signal?: AbortSignal
): Promise<MarketplaceOrderPage> {
    const page = Math.max(1, Math.floor(query.page))
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize)))
    const search = query.search.trim()
    const from = (page - 1) * pageSize
    return fetchMarketplaceOrders(query.workspaceId, async (requestSignal) => {
        let request = supabase
            .from('marketplace_orders')
            .select(MARKETPLACE_ORDER_SELECT, { count: 'exact' })
            .eq('workspace_id', query.workspaceId)
        if (query.status !== 'all') request = request.eq('status', query.status)
        if (query.createdFrom) request = request.gte('created_at', query.createdFrom)
        if (query.createdBefore) request = request.lt('created_at', query.createdBefore)
        if (search) {
            const pattern = `%${escapePostgrestSearch(search)}%`
            request = request.or([
                `order_number.ilike.${pattern}`,
                `customer_name.ilike.${pattern}`,
                `customer_phone.ilike.${pattern}`,
                `customer_city.ilike.${pattern}`
            ].join(','))
        }
        const pageRequest = request
            .order(query.sortBy, { ascending: query.sortDirection === 'asc' })
            .order('id', { ascending: query.sortDirection === 'asc' })
            .range(from, from + pageSize - 1)
        return requestSignal ? pageRequest.abortSignal(requestSignal) : pageRequest
    }, signal)
}

export async function fetchMarketplaceOrderDetail(
    workspaceId: string,
    orderId: string,
    signal?: AbortSignal
): Promise<MarketplaceOrderRecord | null> {
    let request = supabase
        .from('marketplace_orders')
        .select(MARKETPLACE_ORDER_SELECT)
        .eq('workspace_id', workspaceId)
        .eq('id', orderId)
    if (signal) request = request.abortSignal(signal)
    const { data, error } = await runSupabaseAction('ecommerce.fetchOrderDetail', () => request.maybeSingle(), { signal }) as {
            data: MarketplaceOrderDatabaseRecord | null
            error: Error | null
        }
    if (error) throw error
    if (!data) return null
    const returnsById = await loadSalesOrderReturns(workspaceId, data.sales_order_id ? [data.sales_order_id] : [], signal)
    return normalizeMarketplaceOrder(data, data.sales_order_id ? returnsById.get(data.sales_order_id) : undefined, workspaceId)
}

function normalizeSummary(value: unknown): MarketplaceOrderSummary {
    if (!value || typeof value !== 'object') throw new Error('Invalid marketplace order summary')
    const summary = value as Record<string, unknown>
    const count = (key: string) => {
        const result = Number(summary[key])
        if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid marketplace order summary')
        return result
    }
    const orderValueByCurrency = Array.isArray(summary.orderValueByCurrency)
        ? summary.orderValueByCurrency.map((entry) => {
            const row = entry as Record<string, unknown>
            const total = Number(row.total)
            if (typeof row.currency !== 'string' || !Number.isFinite(total)) throw new Error('Invalid marketplace order summary')
            return { currency: row.currency, total }
        })
        : []
    const previousCount = summary.previousCount == null ? null : Number(summary.previousCount)
    if (previousCount !== null && (!Number.isSafeInteger(previousCount) || previousCount < 0)) {
        throw new Error('Invalid marketplace order summary')
    }
    return {
        totalCount: count('totalCount'),
        pendingCount: count('pendingCount'),
        pendingFulfillmentCount: count('pendingFulfillmentCount'),
        deliveredCount: count('deliveredCount'),
        cancelledCount: count('cancelledCount'),
        orderValueByCurrency,
        previousCount,
        minCreatedAt: typeof summary.minCreatedAt === 'string' ? summary.minCreatedAt : null,
        maxCreatedAt: typeof summary.maxCreatedAt === 'string' ? summary.maxCreatedAt : null
    }
}

export async function fetchMarketplaceOrderSummary(
    query: MarketplaceOrderSummaryQuery,
    signal?: AbortSignal
): Promise<MarketplaceOrderSummary> {
    let request = supabase.rpc('get_marketplace_order_summary', {
            p_workspace_id: query.workspaceId,
            p_created_from: query.createdFrom ?? null,
            p_created_before: query.createdBefore ?? null,
            p_previous_from: query.previousFrom ?? null,
            p_previous_before: query.previousBefore ?? null
        })
    if (signal) request = request.abortSignal(signal)
    const { data, error } = await runSupabaseAction('ecommerce.fetchOrderSummary', () => request, { signal }) as { data: unknown; error: Error | null }
    if (error) throw error
    return normalizeSummary(data)
}
