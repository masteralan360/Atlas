import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/query/queryKeys'
import {
    fetchMarketplaceOrderDetail,
    fetchMarketplaceOrderPage,
    fetchMarketplaceOrderSummary,
    type MarketplaceOrderPageQuery,
    type MarketplaceOrderSummaryQuery
} from './marketplaceOrders'

type MarketplaceOrderViewer = { userId?: string | null; role?: string | null }

export function useMarketplaceOrderPage(
    query: MarketplaceOrderPageQuery | null,
    viewer: MarketplaceOrderViewer,
    enabled = true
) {
    return useQuery({
        queryKey: query
            ? queryKeys.ecommerce.page(query, viewer)
            : [...queryKeys.ecommerce.all(undefined), 'page-disabled', viewer.userId ?? null, viewer.role ?? null],
        queryFn: ({ signal }) => {
            if (!query) throw new Error('Marketplace order query is unavailable')
            return fetchMarketplaceOrderPage(query, signal)
        },
        enabled: enabled && Boolean(query)
    })
}

export function useMarketplaceOrderSummary(
    query: MarketplaceOrderSummaryQuery | null,
    viewer: MarketplaceOrderViewer,
    enabled = true
) {
    return useQuery({
        queryKey: query
            ? queryKeys.ecommerce.summary(query, viewer)
            : [...queryKeys.ecommerce.all(undefined), 'summary-disabled', viewer.userId ?? null, viewer.role ?? null],
        queryFn: ({ signal }) => {
            if (!query) throw new Error('Marketplace summary query is unavailable')
            return fetchMarketplaceOrderSummary(query, signal)
        },
        enabled: enabled && Boolean(query)
    })
}

export function useMarketplaceOrderDetail(
    workspaceId: string | undefined,
    orderId: string | undefined,
    viewer: MarketplaceOrderViewer
) {
    return useQuery({
        queryKey: queryKeys.ecommerce.detail(workspaceId, orderId, viewer),
        queryFn: ({ signal }) => {
            if (!workspaceId || !orderId) throw new Error('Marketplace order is unavailable')
            return fetchMarketplaceOrderDetail(workspaceId, orderId, signal)
        },
        enabled: Boolean(workspaceId && orderId)
    })
}
