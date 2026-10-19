import type { OrdersListPageQuery } from '@/local-db/ordersList'

export const queryKeys = {
  orders: {
    all: (workspaceId: string | undefined, orderType: OrdersListPageQuery['orderType']) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'orders', orderType] as const,
    page: (query: OrdersListPageQuery, viewer?: { isRestricted?: boolean; userId?: string }) => {
      const { refreshToken: _refreshToken, ...dataQuery } = query
      return [
        ...queryKeys.orders.all(query.workspaceId, query.orderType),
        'page',
        dataQuery,
        viewer?.isRestricted ?? false,
        viewer?.userId ?? null,
      ] as const
    },
    commissionPreview: (query: OrdersListPageQuery, viewer?: { isRestricted?: boolean; userId?: string }) => {
      const { refreshToken: _refreshToken, ...dataQuery } = query
      return [
        ...queryKeys.orders.all(query.workspaceId, query.orderType),
        'commission-preview',
        dataQuery,
        viewer?.isRestricted ?? false,
        viewer?.userId ?? null,
      ] as const
    },
  },
  invoiceHistory: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'invoice-history'] as const,
    page: (query: {
      workspaceId?: string
      createdFrom?: string
      createdTo?: string
      search?: string
      page: number
      pageSize: number
      sortDirection?: 'asc' | 'desc'
      origin?: 'history' | 'upload'
      viewOwn: boolean
      userId?: string
    }) => [
      ...queryKeys.invoiceHistory.all(query.workspaceId),
      query.createdFrom ?? null,
      query.createdTo ?? null,
      query.search?.trim() ?? '',
      query.page,
      query.pageSize,
      query.sortDirection ?? 'desc',
      query.origin ?? 'history',
      query.viewOwn,
      query.userId ?? null,
    ] as const,
  },
  businessPartners: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'business-partners'] as const,
    directoryPage: (
      workspaceId: string | undefined,
      options: Record<string, unknown>,
      viewer: { featureEnabled: boolean; role?: string | null; userId?: string | null },
    ) => [
      ...queryKeys.businessPartners.all(workspaceId),
      'directory-page',
      options,
      viewer.featureEnabled,
      viewer.role ?? null,
      viewer.userId ?? null,
    ] as const,
  },
} as const

